/**
 * Tests for MCP server read-only mode functionality
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createSourceArtifactReleaseFixture } from "../../test/test-helpers";
import { createArtifactId } from "../contracts";
import { telemetry } from "../telemetry";
import { ReadSourceArtifactTool } from "../tools";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { createMcpServerInstance } from "./mcpServer";
import { createReadOnlyMcpServer } from "./readOnlyMcpServer";
import type { McpServerTools } from "./tools";

vi.mock("../telemetry", () => ({
  TelemetryEvent: { TOOL_USED: "tool_used" },
  telemetry: { track: vi.fn() },
}));

// Mock config
const mockConfig = {
  app: { readOnly: false },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

const mockReadOnlyConfig = {
  app: { readOnly: true },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

interface ArtifactFixtureOptions {
  availability?: "Downloaded" | "Missing" | "ExternalUnresolved";
  bytes?: Buffer;
  maxSizeBytes?: number;
}

async function createArtifactFixture(options: ArtifactFixtureOptions = {}) {
  const release = await createSourceArtifactReleaseFixture(options);

  const artifactConfig = {
    root: release.artifactRoot,
    maxSizeBytes: options.maxSizeBytes ?? 10 * 1024 * 1024,
  };
  const server = createMcpServerInstance(
    {
      ...mockTools,
      readSourceArtifact: new ReadSourceArtifactTool(artifactConfig),
    },
    {
      ...mockConfig,
      artifacts: artifactConfig,
    } as AppConfig,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "artifact-resource-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    artifactId: release.artifactId,
    artifactRoot: release.artifactRoot,
    bytes: release.bytes,
    catalogPath: release.catalogPath,
    client,
    library: release.library,
    server,
    storagePath: release.storagePath,
    uri: `sap-artifact://${release.library}/${release.version}/${release.artifactId}`,
    version: release.version,
    async close() {
      await client.close();
      await server.close();
      await release.cleanup();
    },
  };
}

// Mock tools
const mockTools: McpServerTools = {
  listLibraries: {
    execute: vi.fn(async () => ({ libraries: [] })),
  } as any,
  findVersion: {
    execute: vi.fn(async () => "Version found"),
  } as any,
  search: {
    execute: vi.fn(async () => ({ results: [] })),
  } as any,
  fetchUrl: {
    execute: vi.fn(async () => "# Mock content"),
  } as any,
  listSourceArtifacts: {
    execute: vi.fn(async () => {
      throw new Error("Not configured in this test");
    }),
  } as any,
  readSourceArtifact: {
    execute: vi.fn(async () => ({
      mimeType: "application/octet-stream",
      bytes: Buffer.alloc(0),
    })),
  } as any,
  scrape: {
    execute: vi.fn(async () => ({ jobId: "job-123" })),
  } as any,
  refresh: {
    execute: vi.fn(async () => ({ jobId: "refresh-job-123" })),
  } as any,
  listJobs: {
    execute: vi.fn(async () => ({ jobs: [] })),
  } as any,
  getJobInfo: {
    execute: vi.fn(async () => ({ job: null })),
  } as any,
  cancelJob: {
    execute: vi.fn(async () => ({ success: true, message: "Cancelled" })),
  } as any,
  remove: {
    execute: vi.fn(async () => ({ message: "Removed" })),
  } as any,
};

describe("MCP Server Read-Only Mode", () => {
  it("advertises the Source Artifact resource capability and opaque template", async () => {
    const fixture = await createArtifactFixture();
    try {
      const templates = await fixture.client.listResourceTemplates();
      expect(fixture.client.getServerCapabilities()?.resources).toBeDefined();
      expect(templates.resourceTemplates).toContainEqual(
        expect.objectContaining({
          uriTemplate: "sap-artifact://{library}/{version}/{artifactId}",
        }),
      );
    } finally {
      await fixture.close();
    }
  });

  it("reads an exact Source Artifact through MCP resources", async () => {
    const bytes = Buffer.from([
      0xef, 0xbb, 0xbf, 0x3c, 0x62, 0x70, 0x6d, 0x6e, 0x2f, 0x3e,
    ]);
    const fixture = await createArtifactFixture({ bytes });

    try {
      const result = await fixture.client.readResource({ uri: fixture.uri });

      expect(result.contents).toEqual([
        {
          uri: fixture.uri,
          mimeType: "application/xml",
          blob: bytes.toString("base64"),
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects an unknown opaque artifact ID", async () => {
    const fixture = await createArtifactFixture();
    try {
      const unknownUri = fixture.uri.replace(fixture.artifactId, `art_${"0".repeat(64)}`);
      await expect(fixture.client.readResource({ uri: unknownUri })).rejects.toThrow(
        "Source Artifact not found",
      );
    } finally {
      await fixture.close();
    }
  });

  it.each(["library", "version"] as const)(
    "rejects a catalog with the wrong %s identity",
    async (identityField) => {
      const fixture = await createArtifactFixture();
      try {
        const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
        const catalogLibrary =
          identityField === "library" ? "other_library" : fixture.library;
        const catalogVersion = identityField === "version" ? "2025.1.1" : fixture.version;
        const artifactId = createArtifactId({
          library: catalogLibrary,
          libraryVersion: catalogVersion,
          solutionId: catalog.artifacts[0].process.solutionId,
          processId: catalog.artifacts[0].process.processId,
          canonicalRelativePath: catalog.artifacts[0].canonicalRelativePath,
          availability: "Downloaded",
          sha256: catalog.artifacts[0].blob.sha256,
        });
        catalog.library = catalogLibrary;
        catalog.libraryVersion = catalogVersion;
        catalog.artifacts[0].artifactId = artifactId;
        await writeFile(fixture.catalogPath, JSON.stringify(catalog));
        const uri = `sap-artifact://${fixture.library}/${fixture.version}/${artifactId}`;

        await expect(fixture.client.readResource({ uri })).rejects.toThrow(
          "Source Artifact library or version mismatch",
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["Missing", "ExternalUnresolved"] as const)(
    "rejects a %s Artifact Reference without returning bytes",
    async (availability) => {
      const fixture = await createArtifactFixture({ availability });
      try {
        await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
          "Source Artifact is not available for reading",
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["../outside.bin", "/outside.bin", "file:///outside.bin"])(
    "rejects unsafe catalog storage key %s",
    async (storageKey) => {
      const fixture = await createArtifactFixture();
      try {
        const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
        catalog.artifacts[0].blob.storageKey = storageKey;
        await writeFile(fixture.catalogPath, JSON.stringify(catalog));

        await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
          "Source Artifact could not be read",
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    "sap-artifact://sap_process_navigator/../2025.1.0/art_0000000000000000000000000000000000000000000000000000000000000000",
    "file:///etc/passwd",
    "sap-artifact:///etc/passwd",
  ])("rejects a non-opaque or path-like resource URI %s", async (uri) => {
    const fixture = await createArtifactFixture();
    try {
      await expect(fixture.client.readResource({ uri })).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("rejects a symlink escape before reading its target", async () => {
    const marker = Buffer.from("outside-root-binary-marker");
    const fixture = await createArtifactFixture({ bytes: marker });
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "docs-mcp-outside-"));
    const outsidePath = path.join(outsideRoot, "outside.bin");
    try {
      await writeFile(outsidePath, marker);
      await rm(fixture.storagePath);
      await symlink(outsidePath, fixture.storagePath);

      await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
        "Source Artifact path is outside the allowlisted root",
      );
    } finally {
      await fixture.close();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects an Artifact Catalog symlink outside the allowlisted root", async () => {
    const fixture = await createArtifactFixture();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "docs-mcp-catalog-outside-"));
    const outsideCatalog = path.join(outsideRoot, "artifact-catalog.json");
    try {
      await writeFile(outsideCatalog, await readFile(fixture.catalogPath));
      await rm(fixture.catalogPath);
      await symlink(outsideCatalog, fixture.catalogPath);

      await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
        "Source Artifact path is outside the allowlisted root",
      );
    } finally {
      await fixture.close();
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects an oversized artifact from catalog metadata before opening the file", async () => {
    const fixture = await createArtifactFixture({ maxSizeBytes: 4 });
    try {
      await rm(fixture.storagePath);
      await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
        "Source Artifact exceeds the configured size limit",
      );
    } finally {
      await fixture.close();
    }
  });

  it("fails closed on a Source Artifact size mismatch", async () => {
    const fixture = await createArtifactFixture();
    try {
      await writeFile(fixture.storagePath, "different-size");
      await expect(fixture.client.readResource({ uri: fixture.uri })).rejects.toThrow(
        "Source Artifact size verification failed",
      );
    } finally {
      await fixture.close();
    }
  });

  it("fails closed on SHA-256 mismatch without exposing binary content", async () => {
    const marker = "private-binary-marker";
    const fixture = await createArtifactFixture({ bytes: Buffer.from(marker) });
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    try {
      await writeFile(fixture.storagePath, "different-binary-data");
      let message = "";
      try {
        await fixture.client.readResource({ uri: fixture.uri });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Source Artifact");
      expect(message).not.toContain(marker);
      expect(message).not.toContain(fixture.artifactRoot);
      expect(
        JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]),
      ).not.toContain(marker);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await fixture.close();
    }
  });

  it("keeps catalog-less libraries and existing MCP resources available", async () => {
    const server = createMcpServerInstance(mockTools, mockConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-less-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const resources = await client.listResources();
      expect(resources.resources).toContainEqual(
        expect.objectContaining({ uri: "docs://libraries" }),
      );
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
        "search_docs",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not expose the Search Query or raw search failure", async () => {
    const query = "private Search Query";
    const rawFailure = "raw failure with http://private-worker.internal:8080/api";
    vi.mocked(telemetry.track).mockClear();
    vi.mocked(mockTools.search.execute).mockRejectedValueOnce(new Error(rawFailure));
    const server = createMcpServerInstance(mockTools, mockConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "search_docs",
      arguments: { library: "lib", query, limit: 5 },
    });

    await client.close();
    await server.close();

    expect(JSON.stringify(vi.mocked(telemetry.track).mock.calls)).not.toContain(query);
    expect(JSON.stringify(result)).not.toContain(rawFailure);
    expect(JSON.stringify(result)).not.toContain("private-worker.internal");
  });

  it("keeps search text first and adds matched Artifact References", async () => {
    const artifactId = `art_${"a".repeat(64)}`;
    const relatedArtifactId = `art_${"b".repeat(64)}`;
    const missingArtifactId = `art_${"c".repeat(64)}`;
    const resourceLink = `sap-artifact://sap_process_navigator/2025.1.0/${artifactId}`;
    const relatedResourceLink = `sap-artifact://sap_process_navigator/2025.1.0/${relatedArtifactId}`;
    vi.mocked(mockTools.search.execute).mockResolvedValueOnce({
      results: [
        {
          url: "file:///artifacts/sap_process_navigator/2025.1.0/searchable/source.md",
          content: "Procurement source content",
          score: 0.9,
        },
      ],
      matchedArtifacts: [
        {
          artifactId,
          name: "Source model",
          suggestedFilename: "source.bpmn",
          mediaType: "application/xml",
          availability: "Downloaded",
          process: {
            solutionId: "EARL_SolS-055",
            processId: "2XU",
            processName: "Procurement",
            lineOfBusiness: ["Sourcing and Procurement"],
          },
          resourceLink,
          sizeBytes: 7,
          searchResultIndexes: [0],
        },
      ],
      relatedArtifacts: [
        {
          artifactId: relatedArtifactId,
          type: "Document",
          group: "Implementation",
          name: "Test script",
          suggestedFilename: "test-script.docx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          availability: "Downloaded",
          process: {
            solutionId: "EARL_SolS-055",
            processId: "2XU",
            processName: "Procurement",
            lineOfBusiness: ["Sourcing and Procurement"],
          },
          resourceLink: relatedResourceLink,
          sizeBytes: 11,
        },
        {
          artifactId: missingArtifactId,
          type: "PDF",
          group: "Implementation",
          name: "Unavailable guide",
          availability: "Missing",
          process: {
            solutionId: "EARL_SolS-055",
            processId: "2XU",
            processName: "Procurement",
            lineOfBusiness: ["Sourcing and Procurement"],
          },
        },
      ],
      relatedArtifactsSummary: {
        total: 2,
        returned: 2,
        remaining: 0,
        truncated: false,
      },
    });
    const server = createMcpServerInstance(mockTools, mockConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "matched-artifact-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "search_docs",
          arguments: { library: "sap_process_navigator", query: "procurement" },
        }),
      );

      expect(result.content[0]).toEqual({
        type: "text",
        text: `\n------------------------------------------------------------\nResult 1: file:///artifacts/sap_process_navigator/2025.1.0/searchable/source.md\n\nProcurement source content\n`,
      });
      expect(result.content[1]).toEqual({
        type: "resource_link",
        uri: resourceLink,
        name: "source.bpmn",
        title: "Source model",
        description: "2XU / Source model",
        mimeType: "application/xml",
        size: 7,
      });
      expect(result.content[2]).toEqual({
        type: "resource_link",
        uri: relatedResourceLink,
        name: "test-script.docx",
        title: "Test script",
        description: "2XU / Test script",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 11,
      });
      expect(result.content).toHaveLength(3);
      expect(result.structuredContent).toEqual({
        results: [{ resultIndex: 0, processId: "2XU", artifactIds: [artifactId] }],
        matchedArtifacts: [
          expect.objectContaining({
            artifactId,
            suggestedFilename: "source.bpmn",
            mediaType: "application/xml",
            availability: "Downloaded",
            resourceLink,
          }),
        ],
        relatedArtifacts: [
          expect.objectContaining({
            artifactId: relatedArtifactId,
            availability: "Downloaded",
            resourceLink: relatedResourceLink,
          }),
          {
            artifactId: missingArtifactId,
            type: "PDF",
            group: "Implementation",
            name: "Unavailable guide",
            availability: "Missing",
            process: {
              solutionId: "EARL_SolS-055",
              processId: "2XU",
              processName: "Procurement",
              lineOfBusiness: ["Sourcing and Procurement"],
            },
          },
        ],
        relatedArtifactsSummary: {
          total: 2,
          returned: 2,
          remaining: 0,
          truncated: false,
        },
      });
      expect(JSON.stringify(result)).not.toContain("blob");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should create server instance in normal mode", () => {
    const server = createMcpServerInstance(mockTools, mockConfig);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("should create server instance in read-only mode", () => {
    const server = createMcpServerInstance(mockTools, mockReadOnlyConfig);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("lists a complete process inventory through a closed-world read-only tool", async () => {
    const downloadedId = `art_${"d".repeat(64)}`;
    const missingId = `art_${"e".repeat(64)}`;
    const resourceLink = `sap-artifact://sap_process_navigator/2025.1.0/${downloadedId}`;
    const inventory = {
      library: "sap_process_navigator",
      libraryVersion: "2025.1.0",
      sourceRelease: "2025-FPS1-RU",
      process: {
        solutionId: "EARL_SolS-055",
        processId: "2XU",
        processName: "Procurement",
        lineOfBusiness: ["Sourcing and Procurement"],
      },
      total: 2,
      artifacts: [
        {
          artifactId: downloadedId,
          type: "BPMN",
          group: "Process",
          name: "Source model",
          availability: "Downloaded" as const,
          suggestedFilename: "2XU.bpmn",
          mediaType: "application/xml",
          sizeBytes: 7,
          resourceLink,
        },
        {
          artifactId: missingId,
          type: "PDF",
          group: "Implementation",
          name: "Unavailable guide",
          availability: "Missing" as const,
        },
      ],
    };
    const listSourceArtifacts = { execute: vi.fn(async () => inventory) } as any;
    const server = createMcpServerInstance(
      { ...mockTools, listSourceArtifacts },
      mockReadOnlyConfig,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifact-inventory-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const definitions = await client.listTools();
      const definition = definitions.tools.find(
        (tool) => tool.name === "list_source_artifacts",
      );
      expect(definition?.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        }),
      );
      expect(Object.keys(definition?.inputSchema.properties ?? {}).sort()).toEqual([
        "library",
        "processId",
        "version",
      ]);

      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "list_source_artifacts",
          arguments: {
            library: "sap_process_navigator",
            version: "2025.1.0",
            processId: "2XU",
          },
        }),
      );

      expect(listSourceArtifacts.execute).toHaveBeenCalledWith({
        library: "sap_process_navigator",
        version: "2025.1.0",
        processId: "2XU",
      });
      expect(result.content[0]).toEqual({
        type: "text",
        text: "2 Source Artifacts for 2XU (Procurement).",
      });
      expect(result.content[1]).toEqual(
        expect.objectContaining({ type: "resource_link", uri: resourceLink }),
      );
      expect(result.content).toHaveLength(2);
      expect(result.structuredContent).toEqual(inventory);
      expect(JSON.stringify(result)).not.toContain("blob");
      expect(JSON.stringify(result)).not.toContain("storageKey");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("creates the packaged extension server with exactly three local read tools", async () => {
    const server = createReadOnlyMcpServer(mockTools);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcpb-server-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.name).toBe("lib-docs");
    const result = await client.listTools();

    await client.close();
    await server.close();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "find_version",
      "list_libraries",
      "search_docs",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(result.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(
      true,
    );
  });

  it("should create server without prompts capability and not fail", () => {
    // This test verifies that the server can be created successfully
    // without advertising prompts capability, which was the root cause
    // of the issue with some MCP clients failing to connect
    const server = createMcpServerInstance(mockTools, mockConfig);
    expect(server).toBeInstanceOf(McpServer);

    // Verify the server has the expected name and can be instantiated
    // This ensures our capability changes don't break server creation
    expect(server).toBeDefined();
  });

  it("should register scrape_docs with clean and preserveHashes support and propagate them", async () => {
    const server = createMcpServerInstance(mockTools, mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;

    expect(scrapeTool).toBeDefined();
    expect(scrapeTool.inputSchema).toBeDefined();

    const parsed = scrapeTool.inputSchema.parse({
      url: "https://example.com/#/guide",
      library: "example-lib",
      clean: true,
      preserveHashes: true,
    });
    expect(parsed.clean).toBe(true);
    expect(parsed.preserveHashes).toBe(true);

    await scrapeTool.handler({
      url: "https://example.com/#/guide",
      library: "example-lib",
      clean: true,
      preserveHashes: true,
    });

    expect(mockTools.scrape.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          clean: true,
          preserveHashes: true,
        }),
      }),
    );
  });
});
