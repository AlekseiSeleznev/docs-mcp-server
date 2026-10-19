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
