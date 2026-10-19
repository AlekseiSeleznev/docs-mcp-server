/**
 * Tests for the MCP server factory: read-only mode, server identity (name, title,
 * version), and the instructions sent to clients during initialization.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceArtifactReleaseFixture } from "../../test/test-helpers";
import { createArtifactId } from "../contracts";
import { VersionAlreadyExistsError } from "../store/errors";
import { telemetry } from "../telemetry";
import { ListSourceArtifactsTool, ReadSourceArtifactTool } from "../tools";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { buildDefaultInstructions } from "./defaultInstructions";
import { createMcpServerFactory, resolveServerInstructions } from "./mcpServer";

const createMcpServerInstance = (tools: McpServerTools, config: AppConfig) =>
  createMcpServerFactory(tools, config)();

import { createReadOnlyMcpServer } from "./readOnlyMcpServer";
import type { McpServerTools } from "./tools";

vi.mock("../telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry")>()),
  telemetry: { track: vi.fn() },
}));

// Mock config
const mockConfig = {
  app: { readOnly: false },
  server: { name: "docs-mcp-server" },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

const mockReadOnlyConfig = {
  app: { readOnly: true },
  server: { name: "docs-mcp-server" },
  scraper: { maxPages: 100, maxDepth: 3 },
} as unknown as AppConfig;

interface ArtifactFixtureOptions {
  availability?: "Downloaded" | "Missing" | "ExternalUnresolved";
  bytes?: Buffer;
  effectiveMime?: string;
  manifestMime?: string;
  maxSizeBytes?: number;
  originalName?: string;
  storageKey?: string;
  suggestedName?: string;
  type?: string;
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
  listSourceArtifacts: new ListSourceArtifactsTool({ root: path.resolve("/") }),
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
  listPages: {
    execute: vi.fn(async () => ({
      library: "test",
      version: "",
      total: 0,
      pages: [],
      limit: 50,
      offset: 0,
      hasMore: false,
    })),
  } as any,
  readPage: {
    execute: vi.fn(async () => ({
      url: "https://example.com",
      title: "Test",
      contentType: "text/markdown",
      content: "# Test",
      startChunk: 0,
      totalChunks: 1,
      nextChunk: null,
    })),
  } as any,
};

/** Creates a server the way the entry points do: through the factory, with instructions resolved from the config. */
function createServer(config: AppConfig): McpServer {
  return createMcpServerFactory(mockTools, config)();
}

describe("MCP Server Read-Only Mode", () => {
  it("advertises get_source_artifact as an artifactId-only closed-world read", async () => {
    const fixture = await createArtifactFixture();
    try {
      const tool = (await fixture.client.listTools()).tools.find(
        ({ name }) => name === "get_source_artifact",
      );

      expect(tool).toEqual(
        expect.objectContaining({
          inputSchema: expect.objectContaining({
            additionalProperties: false,
            properties: { artifactId: expect.any(Object) },
            required: ["artifactId"],
          }),
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          }),
        }),
      );
    } finally {
      await fixture.close();
    }
  });

  it("returns the same exact BPMN bytes, MIME, size, and SHA as resources/read", async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x62, 0x70, 0x6d, 0x6e]);
    const fixture = await createArtifactFixture({ bytes });
    try {
      const resourceResult = await fixture.client.readResource({ uri: fixture.uri });
      const toolResult = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId },
        },
        CallToolResultSchema,
      );
      const expectedBlob = bytes.toString("base64");
      const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

      expect(toolResult.isError).toBe(false);
      expect(toolResult.content).toContainEqual({
        type: "resource",
        resource: {
          uri: fixture.uri,
          mimeType: "application/xml",
          blob: expectedBlob,
        },
      });
      expect(toolResult.structuredContent).toEqual({
        artifactId: fixture.artifactId,
        availability: "Downloaded",
        library: fixture.library,
        version: fixture.version,
        originalName: "source.bpmn",
        suggestedFilename: "source.bpmn",
        mimeType: "application/xml",
        sizeBytes: bytes.length,
        sha256: expectedSha256,
        resourceUri: fixture.uri,
      });
      expect(toolResult.content).toContainEqual({
        type: "resource",
        resource: resourceResult.contents[0],
      });
    } finally {
      await fixture.close();
    }
  });

  it.each([
    {
      format: "DOCX",
      bytes: Buffer.from("docx-exact-bytes"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalName: "source",
      suggestedFilename: "source.docx",
    },
    {
      format: "XLSX",
      bytes: Buffer.from("xlsx-exact-bytes"),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      originalName: "registry",
      suggestedFilename: "registry.xlsx",
    },
    {
      format: "PDF",
      bytes: Buffer.from("%PDF-1.7 exact bytes"),
      mimeType: "application/pdf",
      originalName: "guide.pdf",
      suggestedFilename: "guide.pdf",
    },
    {
      format: "TXT",
      bytes: Buffer.from("exact text\r\nbytes", "utf8"),
      mimeType: "text/plain",
      originalName: "notes.txt",
      suggestedFilename: "notes.txt",
    },
  ])(
    "returns exact $format bytes with effective MIME and preserved source names",
    async ({ bytes, format, mimeType, originalName, suggestedFilename }) => {
      const fixture = await createArtifactFixture({
        bytes,
        effectiveMime: mimeType,
        manifestMime: "application/octet-stream",
        originalName,
        storageKey: `source/2XU/${originalName}`,
        suggestedName: suggestedFilename,
        type: format,
      });
      try {
        const result = await fixture.client.callTool(
          {
            name: "get_source_artifact",
            arguments: { artifactId: fixture.artifactId },
          },
          CallToolResultSchema,
        );

        expect(result.isError).toBe(false);
        expect(result.content).toContainEqual({
          type: "resource",
          resource: {
            uri: fixture.uri,
            mimeType,
            blob: bytes.toString("base64"),
          },
        });
        expect(result.structuredContent).toEqual(
          expect.objectContaining({
            originalName,
            suggestedFilename,
            mimeType,
            sizeBytes: bytes.length,
          }),
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it("returns useful non-binary metadata when the artifact exceeds the configured limit", async () => {
    const bytes = Buffer.from("oversized-private-binary");
    const fixture = await createArtifactFixture({ bytes, maxSizeBytes: 4 });
    try {
      await rm(fixture.storagePath);
      const result = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId },
        },
        CallToolResultSchema,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: "Source Artifact exceeds the configured size limit",
        }),
      ]);
      expect(result.content).not.toContainEqual(
        expect.objectContaining({ type: "resource" }),
      );
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          artifactId: fixture.artifactId,
          mimeType: "application/xml",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          maxSizeBytes: 4,
        }),
      );
      expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    } finally {
      await fixture.close();
    }
  });

  it.each(["Missing", "ExternalUnresolved"] as const)(
    "fails closed for a %s artifactId without binary content",
    async (availability) => {
      const fixture = await createArtifactFixture({ availability });
      try {
        const result = await fixture.client.callTool(
          {
            name: "get_source_artifact",
            arguments: { artifactId: fixture.artifactId },
          },
          CallToolResultSchema,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("not available for reading");
        expect(result.content).not.toContainEqual(
          expect.objectContaining({ type: "resource" }),
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it("fails closed for an unknown opaque artifactId", async () => {
    const fixture = await createArtifactFixture();
    try {
      const result = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: `art_${"0".repeat(64)}` },
        },
        CallToolResultSchema,
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Source Artifact not found");
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it.each(["../outside.bin", "/outside.bin", "file:///outside.bin"])(
    "fails closed for a path-escaping catalog key %s",
    async (storageKey) => {
      const fixture = await createArtifactFixture();
      try {
        const catalog = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
        catalog.artifacts[0].blob.storageKey = storageKey;
        await writeFile(fixture.catalogPath, JSON.stringify(catalog));
        const result = await fixture.client.callTool(
          {
            name: "get_source_artifact",
            arguments: { artifactId: fixture.artifactId },
          },
          CallToolResultSchema,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("Source Artifact could not be read");
        expect(JSON.stringify(result)).not.toContain(fixture.artifactRoot);
      } finally {
        await fixture.close();
      }
    },
  );

  it("fails closed for corrupt bytes without leaking bytes or filesystem paths", async () => {
    const marker = "private-binary-marker";
    const fixture = await createArtifactFixture({ bytes: Buffer.from(marker) });
    const errorSpy = vi.spyOn(logger, "error");
    try {
      await writeFile(fixture.storagePath, "tampered-binary-data!");
      const result = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId },
        },
        CallToolResultSchema,
      );
      const publicResult = JSON.stringify(result);
      const logs = JSON.stringify(errorSpy.mock.calls);

      expect(result.isError).toBe(true);
      expect(publicResult).toContain("Source Artifact");
      expect(publicResult).not.toContain(marker);
      expect(publicResult).not.toContain(fixture.artifactRoot);
      expect(logs).not.toContain(marker);
      expect(logs).not.toContain(fixture.artifactRoot);
    } finally {
      errorSpy.mockRestore();
      await fixture.close();
    }
  });

  it("fails closed for a corrupt catalog", async () => {
    const fixture = await createArtifactFixture();
    try {
      await writeFile(fixture.catalogPath, "{not-json");
      const result = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId },
        },
        CallToolResultSchema,
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Source Artifact could not be read");
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when an Office suggested name does not match its verified MIME", async () => {
    const fixture = await createArtifactFixture({
      effectiveMime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalName: "source",
      storageKey: "source/2XU/source",
      suggestedName: "source.xlsx",
      type: "DOCX",
    });
    try {
      const result = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId },
        },
        CallToolResultSchema,
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("suggested filename is invalid");
      expect(result.content).not.toContainEqual(
        expect.objectContaining({ type: "resource" }),
      );
    } finally {
      await fixture.close();
    }
  });

  it("rejects a path-shaped artifactId", async () => {
    const fixture = await createArtifactFixture();
    try {
      const invalidId = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: "../../outside.bin" },
        },
        CallToolResultSchema,
      );

      expect(invalidId.isError).toBe(true);
      expect(JSON.stringify(invalidId)).not.toContain(fixture.artifactRoot);
    } finally {
      await fixture.close();
    }
  });

  it("rejects additional path arguments", async () => {
    const fixture = await createArtifactFixture();
    try {
      const pathArgument = await fixture.client.callTool(
        {
          name: "get_source_artifact",
          arguments: { artifactId: fixture.artifactId, path: fixture.storagePath },
        },
        CallToolResultSchema,
      );

      expect(pathArgument.isError).toBe(true);
      expect(JSON.stringify(pathArgument)).not.toContain(fixture.artifactRoot);
    } finally {
      await fixture.close();
    }
  });

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

  it("returns Related Artifacts when only a Process Card matched", async () => {
    const artifactId = `art_${"f".repeat(64)}`;
    const resourceLink = `sap-artifact://sap_process_navigator/2025.1.0/${artifactId}`;
    vi.mocked(mockTools.search.execute).mockResolvedValueOnce({
      results: [
        {
          url: "file:///artifacts/sap_process_navigator/2025.1.0/searchable/process-cards/2XU.md",
          content: "Procurement process card",
          score: 1,
        },
      ],
      matchedArtifacts: [],
      relatedArtifacts: [
        {
          artifactId,
          type: "BPMN",
          group: "Process",
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
        },
      ],
      relatedArtifactsSummary: {
        total: 1,
        returned: 1,
        remaining: 0,
        truncated: false,
      },
    });
    const server = createMcpServerInstance(mockTools, mockConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "process-card-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "search_docs",
          arguments: { library: "sap_process_navigator", query: "procurement" },
        }),
      );

      expect(result.content[0]).toEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Procurement process card"),
        }),
      );
      expect(result.content[1]).toEqual(
        expect.objectContaining({ type: "resource_link", uri: resourceLink }),
      );
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          matchedArtifacts: [],
          relatedArtifacts: [expect.objectContaining({ artifactId })],
        }),
      );
      expect(JSON.stringify(result)).not.toContain("blob");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should create server instance in normal mode", () => {
    const server = createServer(mockConfig);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("should create server instance in read-only mode", () => {
    const server = createServer(mockReadOnlyConfig);
    expect(server).toBeInstanceOf(McpServer);
  });

  it("exposes only closed-world retrieval tools in read-only mode", async () => {
    const server = createMcpServerInstance(mockTools, mockReadOnlyConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "read-only-surface-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.listTools();

      expect(result.tools.map(({ name }) => name).sort()).toEqual([
        "find_version",
        "get_source_artifact",
        "list_libraries",
        "list_pages",
        "list_source_artifacts",
        "read_page",
        "search_docs",
      ]);
      expect(result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
      expect(
        result.tools.every((tool) => tool.annotations?.openWorldHint === false),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
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
    const listSourceArtifacts = new ListSourceArtifactsTool({ root: path.resolve("/") });
    const listInventory = vi
      .spyOn(listSourceArtifacts, "execute")
      .mockResolvedValue(inventory);
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

      expect(listInventory).toHaveBeenCalledWith({
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

  it("creates the packaged extension server with exactly five local read tools", async () => {
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
      "list_pages",
      "read_page",
      "search_docs",
    ]);
    expect(result.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(result.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(
      true,
    );
  });

  it("keeps full-page publication metadata and continuation identical across transports", async () => {
    const texts: string[] = [];
    for (const server of [
      createMcpServerInstance(mockTools, mockConfig),
      createReadOnlyMcpServer(mockTools),
    ]) {
      vi.mocked(mockTools.readPage.execute).mockResolvedValueOnce({
        url: "https://example.com/book",
        title: "Book",
        contentType: "text/markdown",
        content: "Whole stored chunk",
        startChunk: 1,
        totalChunks: 3,
        nextChunk: 2,
        publication: { authors: ["Jane Doe"], year: 2024 },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "page-publication-test", version: "1.0.0" });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = CallToolResultSchema.parse(
          await client.callTool({
            name: "read_page",
            arguments: {
              library: "books",
              pathOrUrl: "book",
              startChunk: 1,
              maxChars: 100,
            },
          }),
        );
        if (result.content[0]?.type === "text") texts.push(result.content[0].text);
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain("Publication authors: Jane Doe");
    expect(texts[0]).toContain("Publication year: 2024");
    expect(texts[0]).toContain("Whole stored chunk");
    expect(texts[0]).toContain("startChunk: 2");
  });

  it("formats retrieval links and publication metadata identically in full and packaged servers", async () => {
    const texts: string[] = [];
    for (const server of [
      createMcpServerInstance(mockTools, mockConfig),
      createReadOnlyMcpServer(mockTools),
    ]) {
      vi.mocked(mockTools.search.execute).mockResolvedValueOnce({
        results: [
          {
            url: "https://example.com/book",
            contentUrl: "https://example.com/book.md",
            content: "Book excerpt",
            score: 0.9,
            publication: { authors: ["Jane Doe", "John Smith"], year: 2024 },
          },
        ],
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "publication-test", version: "1.0.0" });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = CallToolResultSchema.parse(
          await client.callTool({
            name: "search_docs",
            arguments: { library: "lib", query: "book", limit: 5 },
          }),
        );
        const textResult = result.content[0];
        if (textResult?.type === "text") texts.push(textResult.text);
      } finally {
        await client.close();
        await server.close();
      }
    }

    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain("Result 1: https://example.com/book.md");
    expect(texts[0]).toContain("Publication authors: Jane Doe; John Smith");
    expect(texts[0]).toContain("Publication year: 2024");
  });

  it("should create server without prompts capability and not fail", () => {
    // This test verifies that the server can be created successfully
    // without advertising prompts capability, which was the root cause
    // of the issue with some MCP clients failing to connect
    const server = createServer(mockConfig);
    expect(server).toBeInstanceOf(McpServer);

    // Verify the server has the expected name and can be instantiated
    // This ensures our capability changes don't break server creation
    expect(server).toBeDefined();
  });

  it("should register scrape_docs with replace and preserveHashes support and propagate them", async () => {
    const server = createMcpServerInstance(mockTools, mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;

    expect(scrapeTool).toBeDefined();
    expect(scrapeTool.inputSchema).toBeDefined();

    const parsed = scrapeTool.inputSchema.parse({
      url: "https://example.com/#/guide",
      library: "example-lib",
      replace: true,
      preserveHashes: true,
    });
    expect(parsed.replace).toBe(true);
    expect(parsed.preserveHashes).toBe(true);

    await scrapeTool.handler({
      url: "https://example.com/#/guide",
      library: "example-lib",
      replace: true,
      preserveHashes: true,
    });

    expect(mockTools.scrape.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        replace: true,
        options: expect.objectContaining({
          preserveHashes: true,
        }),
      }),
    );
  });

  it("should normalize includePatterns/excludePatterns to string arrays", async () => {
    const server = createServer(mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;

    // Single pattern passed as a string stays whole, commas preserved
    const single = scrapeTool.inputSchema.parse({
      url: "https://example.com",
      library: "example-lib",
      includePatterns: "/\\/v\\d{1,3}\\//",
    });
    expect(single.includePatterns).toEqual(["/\\/v\\d{1,3}\\//"]);

    // Multiple patterns passed as an array are kept as-is
    const multiple = scrapeTool.inputSchema.parse({
      url: "https://example.com",
      library: "example-lib",
      includePatterns: ["/version-v0.3/", "/versioned_docs/version-v0.3/"],
    });
    expect(multiple.includePatterns).toEqual([
      "/version-v0.3/",
      "/versioned_docs/version-v0.3/",
    ]);

    // The handler receives the normalized array and propagates it to the scraper
    const args = scrapeTool.inputSchema.parse({
      url: "https://example.com",
      library: "example-lib",
      includePatterns: "/version-v0.3/, /versioned_docs/version-v0.3/",
      excludePatterns: ["/exclude/"],
    });
    await scrapeTool.handler(args);

    expect(mockTools.scrape.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          includePatterns: ["/version-v0.3/", "/versioned_docs/version-v0.3/"],
          excludePatterns: ["/exclude/"],
        }),
      }),
    );
  });

  it("should split comma-separated pattern strings without breaking regex constructs", () => {
    const server = createServer(mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;
    const parse = (includePatterns: string) =>
      scrapeTool.inputSchema.parse({
        url: "https://example.com",
        library: "example-lib",
        includePatterns,
      }).includePatterns;

    // Comma inside a regex quantifier is preserved
    expect(parse("/\\/v\\d{1,3}\\//")).toEqual(["/\\/v\\d{1,3}\\//"]);

    // Comma inside glob brace expansion is preserved
    expect(parse("**/*.{js,ts}")).toEqual(["**/*.{js,ts}"]);

    // Comma inside a character class is preserved
    expect(parse("/docs/[a-z,0-9]+/")).toEqual(["/docs/[a-z,0-9]+/"]);

    // Top-level commas split into multiple patterns
    expect(parse("/version-v0.3/, /versioned_docs/version-v0.3/")).toEqual([
      "/version-v0.3/",
      "/versioned_docs/version-v0.3/",
    ]);

    // Escaped commas are treated as literal commas, not separators
    expect(parse("/docs/v1\\,2/")).toEqual(["/docs/v1\\,2/"]);

    // Empty segments are dropped
    expect(parse("/version-v0.3/, , /version-v0.2/")).toEqual([
      "/version-v0.3/",
      "/version-v0.2/",
    ]);
  });

  it("should pass replace to ScrapeTool and default it to false", async () => {
    const server = createServer(mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;

    expect(
      scrapeTool.inputSchema.parse({ url: "https://example.com", library: "lib" })
        .replace,
    ).toBe(false);

    await scrapeTool.handler(
      scrapeTool.inputSchema.parse({
        url: "https://example.com",
        library: "lib",
        replace: true,
      }),
    );

    expect(mockTools.scrape.execute).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true }),
    );
  });

  it("should return an existing-version conflict as a tool error naming the remedy", async () => {
    const server = createServer(mockConfig);
    const scrapeTool = (server as any)._registeredTools.scrape_docs;
    vi.mocked(mockTools.scrape.execute).mockRejectedValueOnce(
      new VersionAlreadyExistsError("React", ""),
    );

    const result = await scrapeTool.handler(
      scrapeTool.inputSchema.parse({ url: "https://example.com", library: "react" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("replace: true");
  });
});

describe("MCP versions resource", () => {
  const listedLibraries = {
    libraries: [
      { name: "React", versions: [{ version: "19.0.0" }] },
      { name: "@tanstack/query", versions: [{ version: "5.0.0" }] },
    ],
  };

  async function readVersions(uri: string) {
    vi.mocked(mockTools.listLibraries.execute).mockResolvedValue(listedLibraries as any);
    const client = await connectClient(createServer(mockConfig));
    const result = await client.readResource({ uri });
    return result.contents.map((content) => ("text" in content ? content.text : ""));
  }

  it("matches a library name case-insensitively", async () => {
    expect(await readVersions("docs://libraries/react/versions")).toEqual(["19.0.0"]);
  });

  it("decodes a percent-encoded name containing a slash", async () => {
    expect(await readVersions("docs://libraries/%40tanstack%2Fquery/versions")).toEqual([
      "5.0.0",
    ]);
  });
});

/**
 * Lists tools the way a 2026-07-28 client sees them: a real `tools/list`
 * request through the SDK's HTTP handler, so the assertions cover the
 * advertised JSON Schema rather than the server's internal registry.
 */
async function listToolsOverTheWire(config: AppConfig) {
  const handler = createMcpHandler(createMcpServerFactory(mockTools, config));
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, any>;
      }>;
    };
  };
  return body.result.tools;
}

describe("MCP tool advertisement over protocol 2026-07-28", () => {
  it("advertises every tool in normal mode", async () => {
    const tools = await listToolsOverTheWire(mockConfig);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "fetch_url",
      "find_version",
      "get_job_info",
      "get_source_artifact",
      "list_jobs",
      "list_libraries",
      "list_pages",
      "list_source_artifacts",
      "read_page",
      "refresh_version",
      "remove_docs",
      "scrape_docs",
      "search_docs",
    ]);
  });

  it("advertises only read tools in read-only mode", async () => {
    const tools = await listToolsOverTheWire(mockReadOnlyConfig);

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_version",
      "get_source_artifact",
      "list_libraries",
      "list_pages",
      "list_source_artifacts",
      "read_page",
      "search_docs",
    ]);
  });

  it("advertises pattern arguments as a string or an array of strings", async () => {
    const tools = await listToolsOverTheWire(mockConfig);
    const scrape = tools.find((tool) => tool.name === "scrape_docs");
    const includePatterns = scrape?.inputSchema.properties.includePatterns;

    expect(includePatterns.anyOf).toEqual([
      { type: "string" },
      { type: "array", items: { type: "string" } },
    ]);
  });

  it("keeps argument descriptions in the advertised schema", async () => {
    const tools = await listToolsOverTheWire(mockConfig);
    const scrape = tools.find((tool) => tool.name === "scrape_docs");
    const search = tools.find((tool) => tool.name === "search_docs");

    expect(scrape?.inputSchema.properties.url.description).toBe(
      "Documentation root URL to scrape.",
    );
    expect(scrape?.inputSchema.properties.includePatterns.description).toMatch(
      /^Patterns for including URLs during scraping/,
    );
    for (const [name, property] of Object.entries(search?.inputSchema.properties ?? {})) {
      expect((property as { description?: string }).description, name).toBeTruthy();
    }
  });
});

/**
 * Connects a real MCP client to the server over an in-memory transport so the
 * initialize handshake can be observed end to end.
 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCP Server identity", () => {
  it("reports the configured server name and the package version", async () => {
    const config = {
      ...mockConfig,
      server: { name: "acme-docs" },
    } as unknown as AppConfig;

    const client = await connectClient(createServer(config));

    expect(client.getServerVersion()).toEqual({
      name: "acme-docs",
      version: __APP_VERSION__,
    });
  });

  it("reports the configured server title alongside the name", async () => {
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", title: "Acme Internal Docs" },
    } as unknown as AppConfig;

    const client = await connectClient(createServer(config));

    expect(client.getServerVersion()).toEqual({
      name: "acme-docs",
      title: "Acme Internal Docs",
      version: __APP_VERSION__,
    });
  });

  it("sends the given instructions to the client", async () => {
    const config = {
      ...mockConfig,
      server: {
        name: "docs-mcp-server",
        instructions: "Search acme docs before answering.",
      },
    } as unknown as AppConfig;

    const client = await connectClient(createServer(config));

    expect(client.getInstructions()).toBe("Search acme docs before answering.");
  });

  it("sends the built-in instructions when none are configured", async () => {
    const client = await connectClient(createServer(mockConfig));

    expect(client.getInstructions()).toBe(buildDefaultInstructions(false));
  });

  it.each([
    { mode: "normal", config: mockConfig },
    { mode: "read-only", config: mockReadOnlyConfig },
  ])(
    "names only registered tools in the built-in instructions ($mode mode)",
    async ({ config }) => {
      const client = await connectClient(createServer(config));
      const { tools } = await client.listTools();
      const registered = tools.map((tool) => tool.name);

      // Tool names are the backtick-quoted snake_case words; parameters like `version` are not.
      const named = [
        ...(client.getInstructions() ?? "").matchAll(/`([a-z]+(?:_[a-z]+)+)`/g),
      ].map((match) => match[1]);

      expect(named.length).toBeGreaterThan(0);
      for (const name of named) {
        expect(registered).toContain(name);
      }
    },
  );
});

describe("resolveServerInstructions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-mcp-instructions-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns configured inline instructions in place of the built-in text", () => {
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructions: "Search acme docs before answering." },
    } as unknown as AppConfig;

    expect(resolveServerInstructions(config)).toBe("Search acme docs before answering.");
  });

  it("returns the configured file contents in place of the built-in text", () => {
    const instructionsFile = path.join(tmpDir, "instructions.md");
    fs.writeFileSync(instructionsFile, "# Acme docs\n\nAlways search first.\n");
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructionsFile },
    } as unknown as AppConfig;

    expect(resolveServerInstructions(config)).toBe(
      "# Acme docs\n\nAlways search first.\n",
    );
  });

  it("returns the built-in instructions for the current mode when none are configured", () => {
    expect(resolveServerInstructions(mockConfig)).toBe(buildDefaultInstructions(false));
    expect(resolveServerInstructions(mockReadOnlyConfig)).toBe(
      buildDefaultInstructions(true),
    );
  });

  it("fails when both inline instructions and an instructions file are set", () => {
    const instructionsFile = path.join(tmpDir, "instructions.md");
    fs.writeFileSync(instructionsFile, "from file");
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructions: "inline", instructionsFile },
    } as unknown as AppConfig;

    expect(() => resolveServerInstructions(config)).toThrow(
      /server\.instructions.*server\.instructionsFile/,
    );
  });

  it("fails when the instructions file cannot be read", () => {
    const instructionsFile = path.join(tmpDir, "missing.md");
    const config = {
      ...mockConfig,
      server: { name: "acme-docs", instructionsFile },
    } as unknown as AppConfig;

    expect(() => resolveServerInstructions(config)).toThrow(/instructions file/i);
  });
});
