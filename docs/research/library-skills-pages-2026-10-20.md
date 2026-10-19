# Library skills and indexed-page reading

The ten public library skills are version 1.1.0. Each standalone ZIP contains
`references/indexed-pages.md`. The shared guide routes known URLs directly to
`read_page`, navigation to `list_pages`, and truncated search context to the same
stored page. Ordinary questions keep the existing bounded search path. Version,
library scope, source attribution and artifact retrieval rules still apply.
The private project skill uses the same page guide and remains unpublished.

## Validation

- Both skill validators pass for all eleven applied skills.
- The updater E2E checks installation of the new page guide, rereading the skill,
  preservation of client settings and notes, and rejection of damaged releases.
- Fresh independent before/after checks use the same three questions and native
  MCP endpoint, without retaining document bodies. NiFi uses two calls, PostgreSQL
  three and SAP three in both runs. Tool time totals fall from 19.065 seconds to
  9.722 seconds; the median scenario falls from 8.152 to 3.874 seconds. These are
  single-run observations, not a speed benchmark.
- PostgreSQL uses `find_version → list_pages → read_page` without search. A
  separate known-URL request reads directly and reports continuation rather than
  claiming the complete page was read.
- SAP's initial after projection omitted availability and was marked partial.
  A separate corrected check confirms four available artifacts; one small file
  passes size, MIME, format and SHA-256 checks in memory. No document bytes are
  retained in the evidence.
- Local installations cover Codex, general agent and Claude skill directories;
  existing client settings are preserved. The private Claude project skill
  remains manually invoked.
- The public site publishes the HTML, ten archives and catalog as one atomic
  directory exchange. The previous directory and a protected archive are kept.

The transport changes and platform checks are described in
[library-page-transports-2026-10-20.md](library-page-transports-2026-10-20.md).

## Deployment acceptance

The local services run the new build and pass real MCP listing/reading checks.
The web service reports its expected embedded worker mode. Both services are
active. Local skill directories contain 30 public installations across Codex,
general agents and Claude; repository symlinks remain symlinks and existing
client metadata is preserved. The private project skill remains unpublished;
its Claude installation disables automatic model invocation.

The remote worker, web, read MCP and admin MCP run immutable image
`ghcr.io/alekseiseleznev/docs-mcp-server@sha256:56b956bc984058452eea85bf419af32f2a13f1da4f04b1ae3ea52d08e407f18f`,
application source `434539e`. The following commit `38ce9ae` corrects extension
packaging and Windows test setup; it does not change the deployed application
behavior. All four production roles are healthy with zero restarts. Reranking
remains enabled with `rerank-3-lite`; provider credentials remain only on the
worker. Worker environment and deployment settings are preserved.

The database retains 120 libraries, 120 versions, 35,983 pages, 187,494 chunks
and vectors, and 128 publication rows. Ordered logical SHA-256 fingerprints of
libraries, versions, pages, document contents and vectors match the consistent
pre-update backup. Migrations match; integrity is `ok`, foreign-key errors zero.
The backup has been checked structurally; no restoration drill is claimed for
this deployment. Previous images, compose settings and site versions remain
available for rollback.

Live read/admin MCP checks pass with their expected seven/fourteen tool
surfaces, stored-page continuation and authors/year. Claude OAuth passes real
login, PKCE, initialization, read-only discovery, search, list and read calls.
The direct web interface renders with a connected worker, an active WebSocket
and no JavaScript or failed-request errors.

The published HTML and catalog match the repository. All ten HTTPS downloads
match the published SHA-256 values. A browser verifies the installation dialog
and selected archive link. Every previous public 1.0.0 package upgrades from the
real site to 1.1.0, preserves client metadata, installs the page guide, and
reports `current` on its next check.

Eight additional live skill probes complete the eleven-skill coverage with
correct scope, version rules and bounded read-only calls. Two ambiguous or
unsupported requests use zero MCP calls. These probes validate retrieval and
routing; they do not provide a comprehensive score for semantic answer quality
or every answer's final formatting. The historical artifact writer and answer
contracts remain covered by the existing tests.

Full local checks: lint, fresh typecheck, build and **3,280 tests PASS**;
three existing skipped tests and six TODO cases remain outside that total.
Both extension CI matrices pass on native runners. The standard application CI
is tracked at [run 39331883422](https://github.com/AlekseiSeleznev/docs-mcp-server/actions/runs/39331883422).
Interactive Claude Desktop GUI testing is not claimed. A separate Claude Code
model invocation is unavailable because the local CLI is not logged in; its
skill files are installed, and Claude's OAuth and desktop MCP protocols are
verified independently.
