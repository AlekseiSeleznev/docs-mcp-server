# Agent Instructions for docs-mcp-server

## Repository Context

- **Repository**: `arabold/docs-mcp-server`
- **Core Stack**: Node.js 22.x, TypeScript, Vite, AlpineJS, TailwindCSS, SQLite (better-sqlite3)
  - **Node Version**: Always use **Node.js v22** for local development and builds, even if `package.json` allows older versions. If `nvm` is installed, run `nvm use 22` before local commands.
- **Tooling**: Biome (lint/format), Vitest (test), Husky (pre-commit)
- **Critical Documentation**:
  - 📖 **Read `README.md`** first for project structure, setup, and configuration details.
  - 🏗️ **Read `ARCHITECTURE.md`** before making changes to understand system design and service interactions.

## Remote Server Access

- When work on the remote deployment server is required, read connection
  parameters from `.secrets.local.env` in the repository root.
- Use `.example.secrets.local.env` as the variable reference. Never place real
  connection values in that example file.
- Never print, log, copy into chat, stage, commit, or otherwise expose values
  loaded from `.secrets.local.env`.
- Do not guess or hard-code remote connection parameters. If a required value is
  absent, report only the missing variable name and ask the user to fill it in.

## Development Workflow

### Key Commands

| Task | Command | Description |
|------|---------|-------------|
| **Setup** | `npm install` | Install dependencies |
| **Build** | `npm run build` | Build both server and web assets |
| **Lint** | `npm run lint` | Check code issues with Biome |
| **Fix** | `npm run lint:fix` | Auto-fix lint issues (add `-- --unsafe` if needed) |
| **Typecheck** | `npm run typecheck` | Run TypeScript compiler checks |
| **Format** | `npm run format` | Format code with Biome |
| **Test All** | `npm test` | Run all tests with Vitest |
| **Test Single** | `npx vitest run <path>` | Run a specific test file (e.g., `src/utils/foo.test.ts`) |

### Git Workflow

- **Branching**: `<type>/<issue>-<desc>` (e.g., `feat/123-add-cache`)
- **Pre-commit**: Husky runs lint, typecheck, and tests. **Never** bypass.
- **Security**: **NEVER** commit secrets, credentials, or sensitive data (e.g., `.env`).

### Dependency Hygiene

- Use `npm ci` (not `npm install`) when you just need `node_modules`; it installs from the lockfile without mutating it. Reserve `npm install` for intentional dependency changes.
- Keep Node 22 — `better-sqlite3` ships a Node-ABI-pinned native binary. Do not bump the engine floor to v24+.
- For occasional CLI tools that aren't part of the runtime (e.g. `promptfoo` for search evals), invoke them via `npx -y <pkg>@<version>` from `package.json` scripts rather than declaring them as dependencies — keeps the dep tree and lockfile clean.
- npm 10 does not record `libc` in `package-lock.json`, so `npm ci` on Linux installs **both** the glibc and musl builds of every prebuilt native package (`@xberg-io/xberg`, `@biomejs/cli`, `lightningcss`, …). The `Dockerfile` prunes the musl copies after `npm ci`. If the lockfile is ever regenerated from scratch with npm 11+, the `libc` fields appear and that prune becomes redundant.

### Commit Messages

Strictly enforced by `commitlint`. Commits will fail if format is incorrect.

- **Format**: `<type>(<scope>): <subject>` (Scope is optional but recommended)
- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **Subject Rules**:
  - Must be **lower case**
  - Must **NOT** end with a period
  - Keep header under 100 characters
- **Body/Footer**:
  - Separate from header with a blank line
  - No line length limit (configured in `commitlint.config.js`)

## Code Style & Conventions

### TypeScript
- **Strictness**: No `any` (unless absolutely necessary), no non-null assertions (`!`).
- **Imports**: All imports at top. Auto-sorted by Biome.
- **Naming**:
  - Classes/Interfaces/Types: `PascalCase`
  - Variables/Functions/Methods: `camelCase`
  - Constants: `UPPER_SNAKE_CASE` (global) or `camelCase` (local)
- **TSDoc**: Mandatory for all exported functions/classes. Summary first, then params/returns.

### Error Handling
- **Boundaries**: Use `try/catch` at API/CLI boundaries.
- **Logging**: Log errors via `logger.error` with `❌` prefix.
- **Response**: Return standard HTTP codes (e.g., 500) for API errors.
- **Safety**: Sanitize binary content from error logs.

### Web UI (AlpineJS + HTMX)
- **Components**: AlpineJS with TSX (`kitajs`).
- **Conditionals**: Use ternary `foo ? <Bar/> : null` (avoid `foo && <Bar/>`).
- **Styling**: TailwindCSS utility classes.

## Environment

- Use Node.js 22 (`nvm use 22`), even though `package.json` allows newer versions. `better-sqlite3` ships a binary pinned to the Node ABI, so do not raise the engine floor.
- Use `npm ci` to get `node_modules`. Use `npm install` only to change dependencies on purpose.
- Run occasional tools such as `promptfoo` through `npx -y <pkg>@<version>` in a `package.json` script instead of adding a dependency.

## Checks

- Run `npm run lint`, `npm run typecheck` and `npm test` before you push. The Husky hooks only run Biome on staged files and commitlint on the message; never bypass them.
- `tsconfig.json` is incremental. Delete `.tsbuildinfo` before a typecheck you rely on, or a warm cache can hide errors that CI catches.
- Run one test file with `npx vitest run <path>`.

## Git

- Branches: `<type>/<issue>-<desc>`, e.g. `feat/123-add-cache`.
- Commits follow Conventional Commits, enforced by commitlint: `<type>(<scope>): <subject>`, with the subject in lower case, no trailing period, and the header under 100 characters.
- Never commit secrets or `.env` files.

## Code

- No `any` unless absolutely necessary, and no non-null assertions (`!`). Biome does not flag either.
- Every exported function and class has TSDoc: a summary first, then params and returns.
- Catch errors at API and CLI boundaries. The API answers with standard HTTP status codes.
- Logging: `console.*` for CLI results, `logger.info` for state changes, `logger.debug` for flow details. Prefix info, warning and error messages with an emoji (`❌` for errors); debug messages have none. Keep binary content out of error logs.
- The web UI follows `src/web/client/CONVENTIONS.md`.

## Tests

- Test observable behavior, not internal state. Prefer E2E, then integration tests; write unit tests for complex logic only. Use `vi.mock()` sparingly.
- `src/foo.ts` is tested in `src/foo.test.ts`, unit and integration tests together. Do not add `*.integration.test.ts` or `*.spec.ts` files.
- System-wide E2E suites live in `test/*-e2e.test.ts`. `test/README.md` describes the mock server, the crawl harness and the worker helpers.
- Each test checks one behavior. Unit tests take under 100 ms.
- `npm test` skips the live and Docker suites: run them with `npm run test:live` and `npm run test:docker`. After changing authentication or discovery, run the manual Clerk check (`npm run test:auth:clerk -- --app <app_id>`).
- Reuse the fixtures in `test/fixtures/`.

## Documentation

- `README.md` is for users, `ARCHITECTURE.md` for developers, and `docs/` for deep dives into subsystems.
- Write declaratively and in the present tense, about what the code does.
- Use Mermaid for workflows and state, with no Markdown formatting in diagram titles.
