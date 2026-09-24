import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeOAuthGateway } from "./claudeOAuthGateway";

const PREFIX = "/plaut-ai-library";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

describe("Claude OAuth gateway", () => {
  let app: FastifyInstance;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "claude-oauth-test-"));
    app = await createClaudeOAuthGateway({
      publicBaseUrl: `https://docs.example.test${PREFIX}`,
      upstreamUrl: "http://mcp-read.internal/mcp",
      sessionEpoch: "1",
      verifyReadToken: async (token) => token === "shared-read-token",
      databasePath: join(directory, "oauth.sqlite"),
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function register(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/register`,
      payload: { redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().client_id;
  }

  async function authorize(clientId: string, token: string): Promise<string> {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CALLBACK,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "client-state",
      resource: `https://docs.example.test${PREFIX}/mcp`,
    });
    const page = await app.inject({ method: "GET", url: `${PREFIX}/authorize?${query}` });
    expect(page.statusCode).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(page.body)?.[1];
    expect(requestId).toBeTruthy();
    const cookie = page.headers["set-cookie"];
    const login = await app.inject({
      method: "POST",
      url: `${PREFIX}/login`,
      headers: {
        cookie: String(cookie).split(";")[0],
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ request_id: String(requestId), token }).toString(),
    });
    if (login.statusCode !== 302) return String(login.statusCode);
    return new URL(String(login.headers.location)).searchParams.get("code") ?? "";
  }

  it("requires OAuth authorization and advertises discovery", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/mcp`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
    const metadata = await app.inject({
      method: "GET",
      url: `${PREFIX}/.well-known/oauth-protected-resource`,
    });
    expect(metadata.json().resource).toBe(`https://docs.example.test${PREFIX}/mcp`);
  });

  it("rejects untrusted redirect URIs at registration", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/register`,
      payload: { redirect_uris: ["https://attacker.example/callback"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("reuses a Claude client registration for the same callbacks", async () => {
    expect(await register()).toBe(await register());
  });

  it("rejects an incorrect shared token without redirecting to Claude", async () => {
    const clientId = await register();
    expect(await authorize(clientId, "wrong-token")).toBe("401");
  });

  it("exchanges a one-time PKCE code, refreshes, and proxies only after authorization", async () => {
    const clientId = await register();
    const code = await authorize(clientId, "shared-read-token");
    expect(code).not.toBe("");
    const token = await app.inject({
      method: "POST",
      url: `${PREFIX}/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const credentials = token.json();
    expect(credentials.access_token).not.toBe("shared-read-token");
    const reused = await app.inject({
      method: "POST",
      url: `${PREFIX}/token`,
      payload: {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
      },
    });
    expect(reused.statusCode).toBe(400);
    const upstream = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const search = await app.inject({
      method: "POST",
      url: `${PREFIX}/mcp`,
      headers: { authorization: `Bearer ${credentials.access_token}` },
      payload: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual({ result: "ok" });
    expect(upstream).toHaveBeenCalledWith(
      "http://mcp-read.internal/mcp",
      expect.objectContaining({
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
    const refresh = await app.inject({
      method: "POST",
      url: `${PREFIX}/token`,
      payload: {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: credentials.refresh_token,
      },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().refresh_token).not.toBe(credentials.refresh_token);
  });

  it("revokes existing OAuth sessions when the shared read token changes", async () => {
    const clientId = await register();
    const code = await authorize(clientId, "shared-read-token");
    const issued = await app.inject({
      method: "POST",
      url: `${PREFIX}/token`,
      payload: {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
      },
    });
    const accessToken = issued.json().access_token;
    await app.close();
    app = await createClaudeOAuthGateway({
      publicBaseUrl: `https://docs.example.test${PREFIX}`,
      upstreamUrl: "http://mcp-read.internal/mcp",
      sessionEpoch: "2",
      verifyReadToken: async (token) => token === "rotated-read-token",
      databasePath: join(directory, "oauth.sqlite"),
    });
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}/mcp`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
