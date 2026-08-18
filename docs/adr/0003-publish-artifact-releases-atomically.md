---
status: accepted
---

# Publish artifact releases atomically

Source Artifact releases are built and validated locally, uploaded to a staging
directory, verified again on the server, and atomically moved into an immutable
version directory before indexing starts. Accepted releases are retained until
an explicit version-scoped administrative removal; MCP has no deletion tool.
This prevents partial uploads from becoming searchable and keeps indexed text,
the Artifact Catalog, and exact source bytes aligned.
