/** OAuth authorization-code gateway for Claude's hosted, read-only MCP connector. */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import formBody from "@fastify/formbody";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

const CALLBACKS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const FIVE_MINUTES = 5 * 60;
const ACCESS_LIFETIME = 60 * 60;
const REFRESH_LIFETIME = 30 * 24 * 60 * 60;
const TOKEN_SCOPE = "mcp:tools";
const LOGIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com; frame-ancestors 'none'";

export interface ClaudeOAuthGatewayConfig {
  publicBaseUrl: string;
  upstreamUrl: string;
  databasePath: string;
  sessionEpoch: string;
  verifyReadToken: (token: string) => Promise<boolean>;
}

interface ClientRow {
  id: string;
  redirect_uris: string;
}

interface PendingRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  expires_at: number;
}

interface CodeRow extends PendingRow {
  resource: string;
}

interface TokenRow {
  client_id: string;
  expires_at: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshToken(): string {
  return randomBytes(32).toString("base64url");
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function html(error = false): string {
  const warning = error
    ? '<p class="error" role="alert">Неверный токен доступа.</p>'
    : "";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plaut AI Library</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;color:#202020;font:16px/1.5 Arial,sans-serif}.card{box-sizing:border-box;width:min(440px,calc(100% - 32px));padding:36px;background:white;border-top:5px solid #fdc402;box-shadow:0 12px 36px #0002}h1{font-size:26px;margin:0 0 12px}p{margin:0 0 20px}label{display:block;margin-bottom:8px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit}input{border:1px solid #aab0b7}button{margin-top:12px;background:#fdc402;border:0;font-weight:bold;cursor:pointer}.error{color:#a12b22;margin:0 0 12px}</style></head><body><main class="card"><h1>Plaut AI Library</h1><p>Введите токен доступа (выдаёт Алексей Селезнев).</p>${warning}<form method="post" action="__ACTION__"><input type="hidden" name="request_id" value="__REQUEST_ID__"><label for="token">Токен доступа</label><input id="token" name="token" type="password" autocomplete="off" required autofocus><button type="submit">Войти</button></form></main></body></html>`;
}

/** Creates an isolated OAuth gateway; all database and network dependencies are explicit. */
export async function createClaudeOAuthGateway(
  config: ClaudeOAuthGatewayConfig,
): Promise<FastifyInstance> {
  const base = new URL(config.publicBaseUrl);
  if (base.protocol !== "https:" || !config.sessionEpoch || !config.databasePath) {
    throw new Error(
      "Claude OAuth gateway needs HTTPS, a session epoch, and a database path",
    );
  }
  const prefix = base.pathname.replace(/\/$/, "");
  if (!prefix || prefix === "/") throw new Error("A dedicated public path is required");
  const issuer = `${base.origin}${prefix}`;
  const resource = `${issuer}/mcp`;
  const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource`;
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_pending(id_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_codes(code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, state TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_tokens(token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  // Increment this non-secret epoch when rotating the shared read token.
  // Existing OAuth sessions are revoked without storing another copy of it.
  const epochFingerprint = digest(`claude-oauth:${config.sessionEpoch}`);
  const previousFingerprint = db
    .prepare("SELECT value FROM oauth_config WHERE key = 'session_epoch'")
    .get() as { value: string } | undefined;
  if (previousFingerprint?.value !== epochFingerprint) {
    db.transaction(() => {
      db.prepare("DELETE FROM oauth_pending").run();
      db.prepare("DELETE FROM oauth_codes").run();
      db.prepare("DELETE FROM oauth_tokens").run();
      db.prepare(
        "INSERT OR REPLACE INTO oauth_config(key,value) VALUES('session_epoch',?)",
      ).run(epochFingerprint);
    })();
  }
  const startupTime = Math.floor(Date.now() / 1000);
  for (const table of ["oauth_pending", "oauth_codes", "oauth_tokens"]) {
    db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(startupTime);
  }
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(formBody);
  app.addHook("onClose", async () => db.close());
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
  });

  const now = (): number => Math.floor(Date.now() / 1000);
  const client = (id: string): ClientRow | undefined =>
    db.prepare("SELECT id, redirect_uris FROM oauth_clients WHERE id = ?").get(id) as
      | ClientRow
      | undefined;
  const validRedirect = (id: string, uri: string): boolean => {
    const row = client(id);
    return row !== undefined && (JSON.parse(row.redirect_uris) as string[]).includes(uri);
  };
  const issueTokens = (
    id: string,
  ): {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  } => {
    const access = freshToken();
    const refresh = freshToken();
    const insert = db.prepare(
      "INSERT INTO oauth_tokens(token_hash,kind,client_id,expires_at) VALUES(?,?,?,?)",
    );
    db.transaction(() => {
      insert.run(digest(access), "access", id, now() + ACCESS_LIFETIME);
      insert.run(digest(refresh), "refresh", id, now() + REFRESH_LIFETIME);
    })();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: ACCESS_LIFETIME,
      scope: TOKEN_SCOPE,
    };
  };
  const oauthError = (reply: import("fastify").FastifyReply, code: string) =>
    reply.code(400).send({ error: code });

  app.get(`${prefix}/.well-known/oauth-protected-resource`, async () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [TOKEN_SCOPE],
  }));
  app.get(`/.well-known/oauth-protected-resource${prefix}/mcp`, async () => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [TOKEN_SCOPE],
  }));
  const authorizationMetadata = async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [TOKEN_SCOPE],
  });
  app.get(`${prefix}/.well-known/oauth-authorization-server`, authorizationMetadata);
  app.get(`/.well-known/oauth-authorization-server${prefix}`, authorizationMetadata);

  app.post(`${prefix}/register`, async (request, reply) => {
    const input = request.body as Record<string, unknown> | undefined;
    const redirects = input?.redirect_uris;
    if (
      !Array.isArray(redirects) ||
      redirects.length === 0 ||
      redirects.length > 2 ||
      !redirects.every((uri) => typeof uri === "string" && CALLBACKS.has(uri)) ||
      (input?.token_endpoint_auth_method !== undefined &&
        input.token_endpoint_auth_method !== "none")
    )
      return oauthError(reply, "invalid_client_metadata");
    // Redirects are restricted to two official Claude callbacks; reuse one
    // public client ID for the same callback set instead of growing the DB.
    const normalizedRedirects = [...new Set(redirects as string[])].sort();
    const serializedRedirects = JSON.stringify(normalizedRedirects);
    const existing = db
      .prepare("SELECT id FROM oauth_clients WHERE redirect_uris = ?")
      .get(serializedRedirects) as { id: string } | undefined;
    const id = existing?.id ?? freshToken();
    if (!existing) {
      db.prepare("INSERT INTO oauth_clients(id,redirect_uris) VALUES(?,?)").run(
        id,
        serializedRedirects,
      );
    }
    reply.code(201).send({
      client_id: id,
      client_id_issued_at: now(),
      redirect_uris: normalizedRedirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get(`${prefix}/authorize`, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const id = field(query.client_id);
    const redirect = field(query.redirect_uri);
    const challenge = field(query.code_challenge);
    const state = field(query.state);
    const requestedResource = field(query.resource) || resource;
    if (
      !validRedirect(id, redirect) ||
      query.response_type !== "code" ||
      query.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
      !state ||
      state.length > 1024 ||
      requestedResource !== resource
    )
      return oauthError(reply, "invalid_request");
    const pending = freshToken();
    db.prepare(
      "INSERT INTO oauth_pending(id_hash,client_id,redirect_uri,code_challenge,state,resource,expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      digest(pending),
      id,
      redirect,
      challenge,
      state,
      resource,
      now() + FIVE_MINUTES,
    );
    reply.header("Content-Security-Policy", LOGIN_CSP);
    reply.header(
      "Set-Cookie",
      `libdocs_oauth=${pending}; HttpOnly; Secure; SameSite=Lax; Path=${prefix}; Max-Age=${FIVE_MINUTES}`,
    );
    return reply
      .type("text/html; charset=utf-8")
      .send(
        html()
          .replace("__ACTION__", `${prefix}/login`)
          .replace("__REQUEST_ID__", pending),
      );
  });

  const failedAttempts = new Map<string, { count: number; until: number }>();
  app.post(`${prefix}/login`, async (request, reply) => {
    const input = request.body as Record<string, unknown> | undefined;
    const pending = field(input?.request_id);
    const cookie = /(?:^|;\s*)libdocs_oauth=([^;]+)/.exec(
      field(request.headers.cookie),
    )?.[1];
    const row = db
      .prepare(
        "SELECT client_id,redirect_uri,code_challenge,state,expires_at FROM oauth_pending WHERE id_hash = ?",
      )
      .get(digest(pending)) as PendingRow | undefined;
    if (!pending || cookie !== pending || !row || row.expires_at < now())
      return oauthError(reply, "invalid_request");
    // Rate-limit this browser authorization attempt, not the shared Apache IP.
    const key = digest(pending);
    const attempt = failedAttempts.get(key);
    if (attempt && attempt.until > now() && attempt.count >= 10)
      return reply.code(429).send({ error: "too_many_requests" });
    let tokenValid = false;
    try {
      tokenValid = await config.verifyReadToken(field(input?.token));
    } catch {
      return reply.code(503).send({ error: "token_verification_unavailable" });
    }
    if (!tokenValid) {
      failedAttempts.set(key, {
        count: (attempt?.until && attempt.until > now() ? attempt.count : 0) + 1,
        until: now() + 15 * 60,
      });
      reply.header("Content-Security-Policy", LOGIN_CSP);
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(
          html(true)
            .replace("__ACTION__", `${prefix}/login`)
            .replace("__REQUEST_ID__", pending),
        );
    }
    failedAttempts.delete(key);
    db.prepare("DELETE FROM oauth_pending WHERE id_hash = ?").run(digest(pending));
    const code = freshToken();
    db.prepare(
      "INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,code_challenge,state,resource,expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      digest(code),
      row.client_id,
      row.redirect_uri,
      row.code_challenge,
      row.state,
      resource,
      now() + FIVE_MINUTES,
    );
    const target = new URL(row.redirect_uri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", row.state);
    reply.header(
      "Set-Cookie",
      `libdocs_oauth=; HttpOnly; Secure; SameSite=Lax; Path=${prefix}; Max-Age=0`,
    );
    return reply.redirect(target.toString());
  });

  app.post(`${prefix}/token`, async (request, reply) => {
    const input = request.body as Record<string, unknown> | undefined;
    const id = field(input?.client_id);
    if (!client(id)) return oauthError(reply, "invalid_client");
    if (input?.grant_type === "authorization_code") {
      const code = field(input.code);
      const verifier = field(input.code_verifier);
      const redirect = field(input.redirect_uri);
      const row = db
        .prepare(
          "SELECT client_id,redirect_uri,code_challenge,state,resource,expires_at FROM oauth_codes WHERE code_hash = ?",
        )
        .get(digest(code)) as CodeRow | undefined;
      if (
        !row ||
        row.client_id !== id ||
        row.redirect_uri !== redirect ||
        row.expires_at < now() ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        createHash("sha256").update(verifier).digest("base64url") !== row.code_challenge
      ) {
        return oauthError(reply, "invalid_grant");
      }
      const deleted = db
        .prepare("DELETE FROM oauth_codes WHERE code_hash = ?")
        .run(digest(code));
      if (deleted.changes !== 1) return oauthError(reply, "invalid_grant");
      return reply.send(issueTokens(id));
    }
    if (input?.grant_type === "refresh_token") {
      const refresh = field(input.refresh_token);
      const row = db
        .prepare(
          "SELECT client_id,expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'",
        )
        .get(digest(refresh)) as TokenRow | undefined;
      if (!row || row.client_id !== id || row.expires_at < now())
        return oauthError(reply, "invalid_grant");
      const deleted = db
        .prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .run(digest(refresh));
      if (deleted.changes !== 1) return oauthError(reply, "invalid_grant");
      return reply.send(issueTokens(id));
    }
    return oauthError(reply, "unsupported_grant_type");
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: `${prefix}/mcp`,
    handler: async (request, reply) => {
      const bearer = /^Bearer (\S+)$/.exec(field(request.headers.authorization))?.[1];
      const row = bearer
        ? (db
            .prepare(
              "SELECT client_id,expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'",
            )
            .get(digest(bearer)) as TokenRow | undefined)
        : undefined;
      if (!row || row.expires_at < now()) {
        reply.header(
          "WWW-Authenticate",
          `Bearer resource_metadata="${resourceMetadata}"`,
        );
        return reply.code(401).send({ error: "unauthorized" });
      }
      const headers: Record<string, string> = {
        Accept: field(request.headers.accept) || "application/json, text/event-stream",
      };
      for (const name of [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const upstream = await fetch(config.upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
        signal: request.raw.signal,
      });
      reply.code(upstream.status);
      for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      if (!upstream.body) return reply.send();
      return reply.send(
        Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream),
      );
    },
  });
  return app;
}
