/**
 * E2E test for MCP server running in stdio mode.
 *
 * This test spawns the MCP server as a child process, communicates via stdin/stdout
 * using the MCP protocol, and verifies basic functionality works correctly.
 */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMatchedArtifactSearchFixture,
  getCliCommand,
  indexMatchedArtifactRepresentation,
} from "./test-helpers";

describe("MCP stdio server E2E", () => {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  beforeEach(() => {
    // Reset state before each test
    client = null;
    transport = null;
  });

  afterEach(async () => {
    // Clean up client connection
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore errors during cleanup
      }
      client = null;
    }

    // Clean up transport
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore errors during cleanup
      }
      transport = null;
    }

  });

  it("should start, respond to initialize, and list tools", async () => {
    // Using vite-node to run TypeScript directly
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const entryPoint = path.join(projectRoot, "src", "index.ts");

    // Build environment without VITEST_WORKER_ID to ensure proper logging behavior
    const testEnv = { ...process.env };
    delete testEnv.VITEST_WORKER_ID;

    const { cmd, args } = getCliCommand();

    // Create stdio transport which spawns its own process
    transport = new StdioClientTransport({
      command: cmd,
      args: args,
      cwd: projectRoot,
      env: {
        ...testEnv,
        DOCS_MCP_STORE_PATH: path.join(projectRoot, "test", ".test-store-stdio"),
        DOCS_MCP_TELEMETRY: "false",
      },
    });

    // Create MCP client
    client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    // Connect client to server via transport
    await client.connect(transport);

    // List available tools - this is a basic operation that should work
    const toolsResult = await client.listTools();

    // Verify we got some tools back
    expect(toolsResult).toBeDefined();
    expect(toolsResult.tools).toBeDefined();
    expect(Array.isArray(toolsResult.tools)).toBe(true);

    // The server should have at least some tools registered
    // Based on the codebase, we expect tools like scrape_docs, search_docs, etc.
    expect(toolsResult.tools.length).toBeGreaterThan(0);

    // Verify some expected tool names
    const toolNames = toolsResult.tools.map((t) => t.name);
    expect(toolNames).toContain("search_docs");
    expect(toolNames).toContain("list_libraries");
  }, 30000);

  it("should handle shutdown gracefully", async () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const entryPoint = path.join(projectRoot, "src", "index.ts");

    // Create stdio transport which spawns its own process
    // Build environment without VITEST_WORKER_ID
    const testEnv = { ...process.env };
    delete testEnv.VITEST_WORKER_ID;

    const { cmd, args } = getCliCommand();

    transport = new StdioClientTransport({
      command: cmd,
      args: args,
      cwd: projectRoot,
      env: {
        ...testEnv,
        DOCS_MCP_STORE_PATH: path.join(projectRoot, "test", ".test-store-stdio"),
        DOCS_MCP_TELEMETRY: "false",
      },
    });

    client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    // Connect
    await client.connect(transport);

    // Verify connection works
    const toolsResult = await client.listTools();
    expect(toolsResult.tools.length).toBeGreaterThan(0);

    // Close the client (should send shutdown/exit)
    await client.close();
    client = null;

    // Close the transport
    await transport.close();
    transport = null;
  }, 30000);

  it("returns process discovery and complete inventory without binary content", async () => {
    const fixture = await createMatchedArtifactSearchFixture();
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const testEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...fixture.env })) {
      if (value !== undefined) {
        testEnv[key] = value;
      }
    }
    delete testEnv.VITEST_WORKER_ID;
    const { cmd, args } = getCliCommand();

    try {
      transport = new StdioClientTransport({
        command: cmd,
        args,
        cwd: projectRoot,
        env: testEnv,
      });
      client = new Client({ name: "artifact-search-e2e", version: "1.0.0" });
      await client.connect(transport);
      await indexMatchedArtifactRepresentation(client, fixture);

      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "search_docs",
          arguments: {
            library: fixture.library,
            version: fixture.version,
            query: "Procurement artifact sentinel",
          },
        }),
      );

      expect(result.content[0]).toEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(fixture.representationContent),
        }),
      );
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "resource_link",
          uri: `sap-artifact://${fixture.library}/${fixture.version}/${fixture.artifactId}`,
          name: "source.bpmn",
          mimeType: "application/xml",
        }),
      );
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          matchedArtifacts: [
            expect.objectContaining({ artifactId: fixture.artifactId }),
          ],
          relatedArtifacts: [
            expect.objectContaining({
              artifactId: fixture.relatedArtifactId,
              availability: "Downloaded",
            }),
            expect.objectContaining({
              artifactId: fixture.missingArtifactId,
              availability: "Missing",
            }),
          ],
          relatedArtifactsSummary: {
            total: 2,
            returned: 2,
            remaining: 0,
            truncated: false,
          },
        }),
      );
      const inventory = CallToolResultSchema.parse(
        await client.callTool({
          name: "list_source_artifacts",
          arguments: {
            library: fixture.library,
            version: fixture.version,
            processId: "2XU",
          },
        }),
      );
      expect(inventory.structuredContent).toEqual(
        expect.objectContaining({
          total: 3,
          artifacts: [
            expect.objectContaining({ artifactId: fixture.artifactId }),
            expect.objectContaining({ artifactId: fixture.relatedArtifactId }),
            expect.objectContaining({
              artifactId: fixture.missingArtifactId,
              availability: "Missing",
            }),
          ],
        }),
      );
      expect(inventory.content).toHaveLength(3);
      expect(JSON.stringify(result)).not.toContain('"blob"');
      expect(JSON.stringify(inventory)).not.toContain('"blob"');
    } finally {
      await fixture.cleanup();
    }
  }, 30000);
});
