# Library skill authoring acceptance

The authoring skill matches the current three applied profiles and the server
3.3.0 page-tool response. It supports new skills without inventing a previous
release, preserves existing profile behavior during updates, and separates
correctness changes from performance optimization.

## Changes

- Page continuation uses the actual text instruction `startChunk: N`. A missing
  JSON `nextChunk` field alone no longer means that a page is complete.
- Validation commands resolve the installed authoring directory and target
  directory independently of the shell's current directory.
- A conditional authoring reference covers the current skill layout, exact MCP
  library identifiers, client policy, catalog projections, package versions,
  updater resources, private/public boundaries, and release verification.
- Existing comparable scenarios retain their PASS results. Optimization measures
  call counts and latency; necessary new page reads are assessed for correctness
  and completeness, rather than rejected merely for adding calls.
- The profile validator checks bundled links and updater resources, release
  identity and recorded hashes. Local client metadata remains an allowed override.
  Markdown examples in code are not mistaken for package links. Malformed links
  produce a validation failure rather than a Python traceback.

## Independent behavior checks

A saved before version and the updated version receive the same request to
prepare an autonomous PostgreSQL skill in separate temporary directories.
Neither evaluation installs or publishes its generated test skill.

The before version fails its literal relative validator command from `/tmp`.
Its page guide expects JSON `nextChunk` although the live response contains a
text instruction, so a strict reading would stop before the end of the page.
The new version validates from `/tmp` and follows the actual continuation to
finish all 33 chunks of the selected long page in two calls.

The updated evaluation forms an ordinary answer about VACUUM with one search,
checks the factual distinctions, source attribution, numbered format and footer,
and passes two negative cases without MCP calls: unsupported major version and
an unspecified database product. It leaves unrequested ZIP publication and
installation explicitly unverified. An independently discovered malformed-link
crash is corrected and the same fixture retested successfully; the original
failure remains in the protected evaluation receipt.

Only anonymized evaluations are retained. Document bodies, credentials and raw
MCP payloads are not stored in the receipts.

## Compatibility and local installation

The profile validator passes all eleven existing applied repository skills,
including catalog routers and artifact writers. Ten filesystem/process E2E cases
cover portable validation, required resources, reference examples, malformed
links, recorded bytes, client overrides and new/reused release identities.

The canonical source and installations in `.agents`, `.codex` and `.claude`
match by file content. Existing symlinks and invocation policy are preserved.
Protected before copies and hashes remain outside the repository.

Only the authoring skill and its tests are changed. Existing published library
packages keep their release identities. The corrected canonical page guide is
used when those packages are next deliberately versioned and built.
