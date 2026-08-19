# Production reranking deployment

This Compose stack runs one search-owning worker and three credential-free
proxies: the web UI, read-only MCP, and administrative MCP. The repository-wide
reranker default stays disabled. The production Compose file enables reranking
only in the worker environment.

The read-only MCP coordinator also serves immutable Source Artifacts from the
existing `artifacts` directory in `grounded-docs-data`. Compose mounts only that
volume subpath at `/artifacts` with `read_only: true` and sets
`DOCS_MCP_ARTIFACT_ROOT=/artifacts` only on `mcp-read`. The worker, web UI, and
administrative MCP keep their existing storage and search configuration.

## Build and pin the image

Build the repository Dockerfile with Node.js 22, push the source-specific tag,
and record its registry manifest digest before changing the stack:

```bash
docker build -t registry.example/docs-mcp-server:issue-24-<git-sha> .
docker push registry.example/docs-mcp-server:issue-24-<git-sha>
docker buildx imagetools inspect \
  registry.example/docs-mcp-server:issue-24-<git-sha>
```

Set `DOCS_MCP_IMAGE` only to the recorded `name@sha256:...` digest. Do not deploy
the mutable source-specific tag. The operator validates the full registry
manifest digest; Compose verifies that an explicit image reference is present.

## Place the Voyage secret

Use `worker.env.example` as a reference. Update the existing untracked
`deploy/remote-grounded/.env.worker` in place so its deployed embedding model,
dimension, base URL, and credential remain intact while adding the Voyage
credential. Only when `.env.worker` is absent, create it without overwriting an
existing file:

```bash
cd deploy/remote-grounded
if [ ! -e .env.worker ]; then
  install -m 600 worker.env.example .env.worker
else
  chmod 600 .env.worker
fi
```

For the ONEC production index, the model remains `openai:baai/bge-m3` at 1024
dimensions:

```dotenv
DOCS_MCP_EMBEDDING_MODEL=openai:baai/bge-m3
DOCS_MCP_EMBEDDINGS_VECTOR_DIMENSION=1024
OPENAI_API_BASE=<existing provider URL>
OPENAI_API_KEY=<existing embedding credential>
VOYAGE_API_KEY=<Voyage credential>
```

Keep these variables only in the deployment secret store consumed as
`.env.worker`; keep that file untracked. Merge the Voyage variable into the
existing file instead of replacing it. Before deployment, validate the Compose
configuration without rendering its credential-bearing environment. Verify the
model and dimension through an allowlisted status check that emits only their
names and safe non-secret values. The shell-wide Compose environment, shared
config volume, web service, and both MCP services stay credential-free. An
enabled local search process exits at startup and reports `VOYAGE_API_KEY` when
the variable is absent.

The production Compose file supplies
`DOCS_MCP_SEARCH_RERANKER_ENABLED=true` and the selected
`DOCS_MCP_SEARCH_RERANKER_CANDIDATE_LIMIT=30` only to `worker`. The shared
application configuration remains disabled by default, so credential-free
proxy processes run only as remote clients of the worker.

## Start and verify

```bash
export DOCS_MCP_IMAGE='registry.example/docs-mcp-server@sha256:<digest>'
docker compose -f deploy/remote-grounded/docker-compose.yml config --quiet
docker compose -f deploy/remote-grounded/docker-compose.yml up -d
docker compose -f deploy/remote-grounded/docker-compose.yml ps
```

Verify the worker healthcheck, the web health response, MCP initialization on
both MCP endpoints, and one normal search through each MCP endpoint. Both
searches execute on the worker and therefore use the worker-owned Reranker.
Inspect the `mcp-read` container and confirm that `/artifacts` is a read-only
volume mount and `DOCS_MCP_ARTIFACT_ROOT` resolves to `/artifacts`. Confirm that
the other three services do not receive either setting. The `artifacts` subpath
must already exist from the accepted publication before recreating `mcp-read`.

Safe operational evidence consists only of the image digest, process health,
MCP initialization status, candidate count, elapsed time, outcome, returned
count, usage-token count, and sanitized fallback category. Configure evidence
collection as an allowlist of these fields; credentials, Authorization headers,
Search Query text, Search Candidate content, provider response bodies, and raw
provider errors remain excluded.

Record the exact merged Git revision, source-specific image tag, and immutable
registry digest as one association before deployment. After deployment, record
an acceptance matrix containing service health; the read-only artifact mount;
Matched and Related Artifact search presence; real Codex `resources/read`,
`list_source_artifacts`, and `get_source_artifact` operations; BPMN, DOCX, XLSX,
PDF, and TXT catalog SHA-256 match results; Missing, integrity-failure, and
oversized outcomes; existing-library and text-only regression results; and the
exact read-only MCP tool-name allowlist. Keep the matrix to identifiers,
PASS/FAIL outcomes, sizes, and hashes. Do not retain artifact bytes, private
paths or URLs, credentials, raw Search Results, or raw error payloads.

## Preserve SQLite data

The worker reuses `grounded-docs-data:/data`. Reranking operates outside the
database schema and reuses the existing index unchanged. Before an image
change, record the SQLite `user_version`, schema, and row counts from a safe
backup or maintenance window. After startup and search, verify that they are
unchanged.

Keep exactly one worker attached to the data volume. Preserve the previous
immutable image reference and Compose configuration until verification is
complete.

## Roll back

1. Set `DOCS_MCP_IMAGE` back to the previous immutable registry manifest digest.
2. Recreate the four services with Docker Compose.
3. Reuse the existing `grounded-docs-data` volume unchanged.
4. Verify worker health, both MCP initializations, and a baseline search.
5. To disable reranking while retaining the new image, remove the worker-only
   `DOCS_MCP_SEARCH_RERANKER_ENABLED=true` override and recreate the worker.

The Source Artifact mount is independently rollback-safe: restoring the prior
Compose file and recreating `mcp-read` removes the read-only mount without
changing the accepted artifact directory or the worker-owned data volume.
