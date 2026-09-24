import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { remoteMcpbArtifactName, type RemoteMcpbTarget } from "../src/build/remoteMcpb";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] as RemoteMcpbTarget | undefined;
if (!target) throw new Error("Pass an MCPB target such as linux-x64");

const upstream = http.createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401).end();
    return;
  }
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "probe", description: "Fixture probe", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: "text", text: params.name === "probe" ? "remote-ok" : "unknown-tool" }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.once("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
});

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "lib-docs-remote-smoke-"));
let client: Client | undefined;
try {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind to TCP");

  const artifactPath = path.join(projectRoot, "artifacts", remoteMcpbArtifactName(target));
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(
    executable,
    ["-y", "@anthropic-ai/mcpb@2.1.2", "unpack", artifactPath, temporaryDirectory],
    { cwd: projectRoot, shell: process.platform === "win32", stdio: "ignore" },
  );

  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  client = new Client({ name: "remote-mcpb-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(temporaryDirectory, "remote-mcpb-dist", "index.js")],
      env: {
        ...environment,
        LIB_DOCS_BEARER_TOKEN: "test-token",
        LIB_DOCS_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
      },
    }),
  );
  const tools = await client.listTools();
  if (tools.tools.map((tool) => tool.name).join(",") !== "probe") {
    throw new Error("The packaged bridge did not forward tools/list");
  }
  const result = await client.callTool({ name: "probe", arguments: {} });
  if (result.content[0]?.type !== "text" || result.content[0].text !== "remote-ok") {
    throw new Error("The packaged bridge did not forward tools/call");
  }
  console.log(`PASS ${remoteMcpbArtifactName(target)}: authenticated tools/list and tools/call`);
} finally {
  await client?.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
