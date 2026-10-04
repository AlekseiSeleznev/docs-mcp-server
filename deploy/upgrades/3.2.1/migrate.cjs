/** Apply the two additive 3.2.1 migrations without rewriting an unchanged index. */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
const Database = runtimeRequire("better-sqlite3");
const sqliteVec = runtimeRequire("sqlite-vec");

const expected = new Map([
  [
    "015-add-progress-pages-indexed.sql",
    "447285146cadcbe590bb6645b0954a2d99886793b789bea0be85ca3f66532d3f",
  ],
  [
    "016-add-content-url-to-pages.sql",
    "681773e1a9f0478355e1a60a019869678bcfdd4cb9b384511e7187b67b50fced",
  ],
]);
const databasePath = process.argv[2];
const migrationDirectory = process.argv[3] ?? path.join(process.cwd(), "db/migrations");
const apply = process.argv[4] === "--apply";
if (!databasePath) throw new Error("Pass the database path, migration directory and optional --apply");
const db = new Database(databasePath, { fileMustExist: true, readonly: !apply });
sqliteVec.load(db);

try {
  db.pragma("busy_timeout = 10000");
  const applied = new Set(db.prepare("SELECT id FROM _schema_migrations").all().map((row) => row.id));
  const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).sort();
  const pending = files.filter((file) => !applied.has(file));
  if (!applied.has("015-add-page-publication-metadata.sql")) {
    throw new Error("The custom publication migration must already be present");
  }
  if (pending.some((file) => !expected.has(file))) {
    throw new Error("Unexpected pending migrations; use the normal migration runner");
  }
  const statements = new Map();
  for (const [file, digest] of expected) {
    const sql = fs.readFileSync(path.join(migrationDirectory, file), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== digest) {
      throw new Error("Migration contents differ from the reviewed 3.2.1 release");
    }
    statements.set(file, sql);
  }
  const before = db.prepare(`SELECT
    (SELECT count(*) FROM libraries) libraries,
    (SELECT count(*) FROM versions) versions,
    (SELECT count(*) FROM pages) pages,
    (SELECT count(*) FROM documents) documents,
    (SELECT count(*) FROM pages WHERE publication_metadata IS NOT NULL) publications
  `).get();
  const started = Date.now();
  if (apply && pending.length) {
    db.transaction(() => {
      for (const file of pending) {
        db.exec(statements.get(file));
        db.prepare("INSERT INTO _schema_migrations (id) VALUES (?)").run(file);
      }
    }).immediate();
  }
  const schemaReady = db.pragma("table_info(pages)").some((column) => column.name === "content_url") &&
    db.pragma("table_info(versions)").some((column) => column.name === "progress_pages_indexed");
  if (apply && !schemaReady) throw new Error("Required columns are missing after migration");
  console.log(JSON.stringify({ mode: apply ? "apply" : "check", pending, schemaReady, counts: before, elapsedMs: Date.now() - started, vacuum: false }));
} catch {
  console.error("Upgrade migration failed; inspect the database schema and migration history before retrying");
  process.exitCode = 1;
} finally {
  db.close();
}
