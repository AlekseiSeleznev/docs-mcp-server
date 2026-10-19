# Library page tools across MCP transports

Checked on 2026-10-20 with Node.js 22. This receipt covers the transport changes; deployment and native CI results are recorded separately.

## Behavior

The local Claude Desktop extension exposes five indexed-document tools: `find_version`, `list_libraries`, `search_docs`, `list_pages`, and `read_page`. It opens SQLite read-only. Page listing supports a URL filter and offset pagination. Page reading uses the same stored URL resolution, ambiguous-path errors, whole-chunk windows, and `startChunk` continuation as the main HTTP/stdio server.

The shared page reader retains recorded publication authors and year. Both server implementations print those fields with the same labels as search results. Missing metadata stays absent. Search formatting remains unchanged.

Version resolution uses the existing 3.3.0 ladder for exact labels, partial versions, semantic ranges, prereleases, and opaque tags. The implementation is shared between the main service and local desktop extension. The existing version-resolution E2E suite passes.

The remote desktop bridge forwards the seven library retrieval tools, including both page tools and source artifact tools. It forwards artifact resource listing, templates, and reads when the upstream advertises resources. Its tool allowlist rejects writes and arbitrary fetching even if the selected upstream advertises them. Authentication stays on the upstream connection; the test uses an isolated synthetic credential and stores no production responses.

The local extension manifest/version is **3.3.1**; the remote extension is **4.0.1**. The application package remains **3.3.0**, with Node.js 22. Native CI artifact paths use the new extension versions.

## Verification

| Check | Result |
|---|---|
| Focused Vitest run: nine suites, 208 tests | PASS |
| Real SQLite + SDK1 page tools: pagination/filtering, continuation and publication, ambiguous paths, missing absolute URL, version labels, write/fetch rejection | PASS |
| SQLite file SHA-256 unchanged after every desktop page test | PASS |
| Main SDK2 and desktop SDK1 full-page formatting parity | PASS |
| Existing main document-management and version-resolution E2E contracts | PASS |
| Cold TypeScript check after deleting `.tsbuildinfo` | PASS |
| Biome on all 20 changed source/test files | PASS |
| `git diff --check` | PASS |
| Local read-only server bundle build | PASS |
| Local built bundle over a real stdio client against seeded SQLite (`smoke:mcpb -- --bundle`) | PASS |
| Remote Linux x64 MCPB packaging and authenticated HTTP-to-stdio smoke | PASS |
| Remote smoke: actual list/read arguments, pagination, next-chunk hint, publication metadata, artifact resource bytes, templates, rejected write call | PASS |
| Windows/macOS native packages and runners | PASS on native CI at `38ce9ae` |
| Interactive Claude Desktop application on Windows/macOS | NOT_CHECKED |

The cross-platform packaging guard remains enabled. Linux cannot produce native Windows/macOS artifacts through the supported build scripts. Run `mcpb.yml` and `remote-mcpb.yml` on the final revision for native acceptance.

Focused test command:

```sh
npx vitest run src/mcp/readOnlyMcpServer.test.ts src/mcp/mcpServer.test.ts src/build/mcpb.test.ts src/build/remoteMcpb.test.ts test/version-resolution-e2e.test.ts src/store/DocumentManagementService.test.ts src/tools/ListPagesTool.test.ts src/tools/ReadPageTool.test.ts src/utils/version.test.ts
```

## Native CI findings and corrections

The first native run on application revision `434539e` exposed two packaging/test-launch defects. All three local native packages built but failed the unpacked runtime smoke because the page-reader URL helper left an external `psl` import, while the extension's runtime package omitted that dependency. The remote Windows job failed in Vitest global setup before running tests: Windows distributes npm through a `.cmd` shim, and `execFileSync("npm")` without the Windows shell could not launch it. The remote Linux and both macOS jobs passed in that run.

The local runtime package now includes `psl` at the application's locked version. Its package-generation function is shared between the native packager and a new `smoke:mcpb -- --isolated-bundle` mode. That smoke installs the same runtime dependencies into a temporary directory outside the repository, then runs the built stdio server against a seeded SQLite store. The repository's `node_modules` can no longer mask an omitted runtime dependency in this check. This isolated Linux smoke passes, including actual page listing, whole-chunk continuation and publication metadata.

Vitest global setup now uses the command shell on Windows to launch the npm shim; Unix execution remains direct. No test or native packaging check is disabled.

Correction checks: three focused suites / 13 tests PASS, TypeScript PASS, `git diff --check` PASS. Native reruns at `38ce9ae` pass: [local extension, all three targets](https://github.com/AlekseiSeleznev/docs-mcp-server/actions/runs/39331884491) and [remote extension, all four targets](https://github.com/AlekseiSeleznev/docs-mcp-server/actions/runs/39331888677). The unpacked Linux remote package also passes against the deployed server: seven read-only tools, page reading, byte/hash equality between artifact retrieval and resource reading, and rejected writes. Interactive desktop GUI acceptance remains outside these protocol checks.
