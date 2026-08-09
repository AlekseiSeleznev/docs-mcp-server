# Production reranking deployment

This Compose stack runs one search-owning worker and three credential-free
proxies: the web UI, read-only MCP, and administrative MCP. The repository-wide
reranker default stays disabled. The production Compose file enables reranking
only in the worker environment.

## Build and pin the image

Build the repository Dockerfile with Node.js 22 and give the result an immutable
tag. Record its content digest before changing the stack:

```bash
docker build -t registry.example/docs-mcp-server:issue-6-<git-sha> .
docker image inspect registry.example/docs-mcp-server:issue-6-<git-sha> \
  --format '{{index .RepoDigests 0}}'
```

Set `DOCS_MCP_IMAGE` to that immutable tag or, preferably, to the recorded
`name@sha256:...` digest. The Compose file rejects an unset image reference and
does not provide a mutable fallback tag.

## Place the Voyage secret

Create `deploy/remote-grounded/.env.worker` in the deployment secret store with
this single required variable:

```dotenv
VOYAGE_API_KEY=<secret value>
```

Do not put this variable in the shell-wide Compose environment, shared config
volume, web service, or either MCP service. Do not commit `.env.worker`. An
enabled local search process exits at startup and reports `VOYAGE_API_KEY` when
the variable is absent.

The production Compose file supplies
`DOCS_MCP_SEARCH_RERANKER_ENABLED=true` only to `worker`. The shared application
configuration remains disabled by default, so credential-free proxy processes
do not initialize a Reranker.

## Start and verify

```bash
export DOCS_MCP_IMAGE='registry.example/docs-mcp-server@sha256:<digest>'
docker compose -f deploy/remote-grounded/docker-compose.yml config
docker compose -f deploy/remote-grounded/docker-compose.yml up -d
docker compose -f deploy/remote-grounded/docker-compose.yml ps
```

Verify the worker healthcheck, the web health response, MCP initialization on
both MCP endpoints, and one normal search through each MCP endpoint. Both
searches execute on the worker and therefore use the worker-owned Reranker.

Safe operational evidence consists only of the image digest, process health,
MCP initialization status, candidate count, elapsed time, outcome, returned
count, usage-token count, and sanitized fallback category. Never collect the
Voyage credential, Authorization headers, Search Query text, Search Candidate
content, provider response bodies, or raw provider errors in logs or evidence.

## Preserve SQLite data

The worker reuses `grounded-docs-data:/data`. Reranking is stateless and adds no
database migration, schema change, or reindex step. Before an image change,
record the SQLite `user_version`, schema, and row counts from a safe backup or
maintenance window. After startup and search, verify that they are unchanged.

Do not attach the data volume to two workers at the same time. Keep the previous
immutable image reference and Compose configuration until verification is
complete.

## Roll back

1. Set `DOCS_MCP_IMAGE` back to the previous immutable tag or digest.
2. Recreate the four services with Docker Compose.
3. Reuse the existing `grounded-docs-data` volume; do not migrate or reindex it.
4. Verify worker health, both MCP initializations, and a baseline search.
5. To disable reranking while retaining the new image, remove the worker-only
   `DOCS_MCP_SEARCH_RERANKER_ENABLED=true` override and recreate the worker.

