/** Dedicated process entry point for Claude's OAuth-enabled read-only MCP. */
import { randomBytes } from "node:crypto";
import { createClaudeOAuthGateway } from "./claudeOAuthGateway";

const publicBaseUrl = process.env.CLAUDE_OAUTH_PUBLIC_BASE_URL;
const databasePath = process.env.CLAUDE_OAUTH_DATABASE_PATH;
const upstreamUrl = process.env.CLAUDE_OAUTH_UPSTREAM_URL;
const verificationUrl = process.env.CLAUDE_OAUTH_VERIFY_URL;
const sessionEpoch = process.env.CLAUDE_OAUTH_SESSION_EPOCH ?? "1";
const port = Number(process.env.CLAUDE_OAUTH_PORT ?? "16283");
const host = process.env.CLAUDE_OAUTH_HOST ?? "127.0.0.1";

if (
  !publicBaseUrl ||
  !databasePath ||
  !sessionEpoch ||
  upstreamUrl !== "http://127.0.0.1:16281/mcp" ||
  verificationUrl !== "http://127.0.0.1:6281/mcp" ||
  host !== "127.0.0.1" ||
  !Number.isInteger(port)
) {
  throw new Error("Claude OAuth gateway configuration is incomplete");
}

async function verifyReadToken(token: string): Promise<boolean> {
  if (!token) return false;
  const response = await fetch("http://127.0.0.1:6281/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-oauth-token-check", version: "1" },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status === 401) return false;
  if (response.status === 200) return true;
  throw new Error("Read-only MCP token verification is unavailable");
}

// Refuse to expose the login form if the verification route stops enforcing
// the read-only Bearer secret. No credential is stored in this process.
if (await verifyReadToken(randomBytes(32).toString("base64url"))) {
  throw new Error("Read-only MCP verification route is not protected");
}

const app = await createClaudeOAuthGateway({
  publicBaseUrl,
  upstreamUrl,
  databasePath,
  sessionEpoch,
  verifyReadToken,
});
await app.listen({ host, port });
process.on("SIGTERM", () => void app.close());
process.on("SIGINT", () => void app.close());
