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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { remoteMcpbArtifactName, type RemoteMcpbTarget } from "../src/build/remoteMcpb";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] as RemoteMcpbTarget | undefined;
if (!target) throw new Error("Pass an MCPB target such as linux-x64");
const names = [
  "find_version",
  "list_libraries",
  "search_docs",
  "list_pages",
  "read_page",
  "list_source_artifacts",
  "get_source_artifact",
];
const resourceUri = "docs-mcp://source-artifacts/fixture/stable/files/guide.pdf";
let writeCalls = 0;

const upstream = http.createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer test-token") {
    response.writeHead(401).end();
    return;
  }
  const server = new Server(
    { name: "fixture", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // The fixture deliberately advertises a write tool: the bridge must exclude it.
    tools: [...names, "scrape_docs"].map((name) => ({
      name,
      description: "Fixture",
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "scrape_docs") writeCalls++;
    if (params.name === "list_pages") {
      if (params.arguments?.offset !== 1 || params.arguments?.contains !== "guide")
        throw new Error("List arguments lost");
      return {
        content: [
          {
            type: "text",
            text: "Indexed pages: guide\nUse offset: 2 to see the next batch of pages.",
          },
        ],
      };
    }
    if (params.name === "read_page") {
      if (params.arguments?.startChunk !== 2 || params.arguments?.maxChars !== 100)
        throw new Error("Read arguments lost");
      return {
        content: [
          {
            type: "text",
            text: "> Source: https://example.com/guide\nPublication authors: Jane Doe\nPublication year: 2024\nStored page content\nTo continue, call read_page again with startChunk: 3.",
          },
        ],
      };
    }
    if (params.name === "get_source_artifact") {
      return {
        content: [
          {
            type: "resource_link",
            uri: resourceUri,
            name: "guide.pdf",
            mimeType: "application/pdf",
          },
        ],
      };
    }
    return { content: [{ type: "text", text: "fixture-ok" }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "docs-mcp://source-artifacts/{library}/{version}/files/{path}",
        name: "Source artifact",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== resourceUri) throw new Error("Resource URI lost");
    return {
      contents: [
        {
          uri: resourceUri,
          mimeType: "application/pdf",
          blob: Buffer.from("fixture-artifact").toString("base64"),
        },
      ],
    };
  });
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
  if (!address || typeof address === "string")
    throw new Error("Fixture did not bind to TCP");
  const artifactPath = path.join(
    projectRoot,
    "artifacts",
    remoteMcpbArtifactName(target),
  );
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["-y", "@anthropic-ai/mcpb@2.1.2", "unpack", artifactPath, temporaryDirectory],
    { cwd: projectRoot, shell: process.platform === "win32", stdio: "ignore" },
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
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
  if (
    JSON.stringify(tools.tools.map((tool) => tool.name).sort()) !==
    JSON.stringify([...names].sort())
  )
    throw new Error("Packaged read-only tool list differs");
  const listing = await client.callTool({
    name: "list_pages",
    arguments: { library: "fixture", contains: "guide", limit: 1, offset: 1 },
  });
  if (!JSON.stringify(listing).includes("Use offset: 2"))
    throw new Error("Page pagination was not forwarded");
  const page = await client.callTool({
    name: "read_page",
    arguments: { library: "fixture", pathOrUrl: "guide", startChunk: 2, maxChars: 100 },
  });
  if (
    ![
      "Stored page content",
      "startChunk: 3",
      "Publication authors: Jane Doe",
      "Publication year: 2024",
    ].every((text) => JSON.stringify(page).includes(text))
  )
    throw new Error("Read continuation or publication metadata lost");
  const blocked = await client.callTool({ name: "scrape_docs", arguments: {} });
  if (!blocked.isError || writeCalls !== 0)
    throw new Error("Bridge forwarded a write tool");
  const artifact = await client.callTool({
    name: "get_source_artifact",
    arguments: { library: "fixture", path: "guide.pdf" },
  });
  if (!JSON.stringify(artifact).includes(resourceUri))
    throw new Error("Artifact resource link lost");
  const resource = await client.readResource({ uri: resourceUri });
  if (resource.contents[0]?.blob !== Buffer.from("fixture-artifact").toString("base64"))
    throw new Error("Artifact bytes lost");
  if ((await client.listResourceTemplates()).resourceTemplates.length !== 1)
    throw new Error("Resource templates lost");
  await client.listResources();
  console.log(
    `PASS ${remoteMcpbArtifactName(target)}: authenticated page reads, pagination, publication, artifacts and write rejection`,
  );
} finally {
  await client?.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
