---
status: accepted
---

# Separate search content and source artifacts

Grounded Docs treats Source Artifacts as a generic library capability rather
than an SAP-specific feature. Each immutable Library Version keeps exact source
bytes and a trusted Artifact Catalog outside the text index in a shared
read-only store; Search Results remain text-first and can refer to artifacts
that are read only on demand. A library is uploaded, indexed, and verified
before its Source Artifact delivery is added to MCP. Source Artifacts use the
server's existing binary access model: a connected client can read every
library, and a skill guides tool use without acting as an authorization gate.
