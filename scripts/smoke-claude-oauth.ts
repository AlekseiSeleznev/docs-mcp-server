/** Credential-safe end-to-end smoke of the deployed Claude OAuth read-only MCP. */
import { createHash, randomBytes } from "node:crypto";

const sharedToken = process.env.REMOTE_DOCS_MCP_READ_BEARER_TOKEN;
if (!sharedToken) throw new Error("REMOTE_DOCS_MCP_READ_BEARER_TOKEN is missing");
const base = "https://aichat.msgplaut.com/plaut-ai-library";
const callback = "https://claude.ai/api/mcp/auth_callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function json(response: Response, expected: number, label: string) {
  if (response.status !== expected) throw new Error(`${label} failed (${response.status})`);
  return response.json();
}

const unauthorized = await fetch(`${base}/mcp`, { method: "POST" });
if (unauthorized.status !== 401) throw new Error("Unauthenticated MCP was not rejected");
await unauthorized.body?.cancel();

const registration = await json(
  await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: "none" }),
  }),
  201,
  "DCR registration",
);
const clientId = registration.client_id as string;
const authorization = await fetch(
  `${base}/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "smoke-test",
    resource: `${base}/mcp`,
  })}`,
);
if (authorization.status !== 200) throw new Error("Authorization page failed");
const csp = authorization.headers.get("content-security-policy") ?? "";
if (!csp.includes("form-action 'self' https://claude.ai https://claude.com")) {
  throw new Error("Claude callback redirects are blocked by the login CSP");
}
const requestId = /name="request_id" value="([^"]+)"/.exec(await authorization.text())?.[1];
const cookie = authorization.headers.get("set-cookie")?.split(";")[0];
if (!requestId || !cookie) throw new Error("Authorization form is incomplete");
const login = await fetch(`${base}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ request_id: requestId, token: sharedToken }),
});
if (login.status !== 302) throw new Error(`Shared-token login failed (${login.status})`);
const code = new URL(login.headers.get("location") ?? "").searchParams.get("code");
if (!code) throw new Error("Authorization code is missing");
const credentials = await json(
  await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    }),
  }),
  200,
  "PKCE token exchange",
);
const access = credentials.access_token as string;
const mcpHeaders = {
  authorization: `Bearer ${access}`,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const initialize = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-oauth-smoke", version: "1" },
    },
  }),
});
if (initialize.status !== 200) throw new Error(`MCP initialize failed (${initialize.status})`);
const sessionId = initialize.headers.get("mcp-session-id");
await initialize.body?.cancel();
const tools = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { ...mcpHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
const body = await tools.text();
if (tools.status !== 200 || !body.includes('"tools"')) {
  throw new Error(`MCP tools/list failed (${tools.status})`);
}
if (body.includes('"scrape_docs"') || body.includes('"remove_docs"')) {
  throw new Error("A write tool was exposed through the read-only gateway");
}
const search = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { ...mcpHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "search_docs",
      arguments: { library: "nifi", query: "GenerateFlowFile processor", limit: 1 },
    },
  }),
});
const searchBody = await search.text();
if (
  search.status !== 200 ||
  !searchBody.includes('"result"') ||
  searchBody.includes('"isError":true') ||
  searchBody.includes("Search failed")
) {
  throw new Error(`MCP search_docs failed (${search.status})`);
}
process.stdout.write("Claude OAuth live smoke: PASS (login, PKCE, MCP initialize, read-only tools, search_docs)\n");
