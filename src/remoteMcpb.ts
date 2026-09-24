import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_MCP_URL = "https://aichat.msgplaut.com/lib-docs/mcp";

/** Starts the read-only desktop bridge to the hosted lib-docs MCP server. */
export async function startRemoteMcpb(): Promise<void> {
  const token = process.env.LIB_DOCS_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "The lib-docs Bearer token is not configured in the extension settings.",
    );
  }

  const endpoint = new URL(process.env.LIB_DOCS_MCP_URL ?? DEFAULT_MCP_URL);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new Error("The lib-docs endpoint must use HTTPS.");
  }

  const upstream = new Client({ name: "lib-docs-desktop", version: "4.0.0" });
  await upstream.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );

  const server = new Server(
    { name: "lib-docs", version: "4.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    upstream.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.callTool(request.params),
  );
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await server.close();
    await upstream.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.env.LIB_DOCS_MCPB_TEST_IMPORT !== "1") {
  startRemoteMcpb().catch(() => {
    // Never log an upstream exception: some HTTP clients include request headers.
    process.stderr.write("lib-docs: connection failed; check the endpoint and token.\n");
    process.exitCode = 1;
  });
}
