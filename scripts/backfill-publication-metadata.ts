import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  extractPublicationMetadata,
  parsePublicationMetadata,
} from "../src/publicationMetadata";

interface PageRow {
  id: number;
  library: string;
  title: string | null;
  url: string;
  publication_metadata: string | null;
}

interface ChunkRow {
  content: string;
}

const args = process.argv.slice(2);
const databasePath = requiredArg("--database");
const reportPath = requiredArg("--report");
const libraryPrefix = optionalArg("--library-prefix") ?? "sap_books_";
const apply = args.includes("--apply");

const db = new Database(databasePath, apply ? undefined : { readonly: true });
sqliteVec.load(db);

try {
  const pages = db
    .prepare(
      `SELECT p.id, l.name AS library, p.title, p.url, p.publication_metadata
       FROM pages p
       JOIN versions v ON v.id = p.version_id
       JOIN libraries l ON l.id = v.library_id
       WHERE l.name GLOB ?
       ORDER BY l.name, p.url`,
    )
    .all(`${libraryPrefix}*`) as PageRow[];
  const chunks = db.prepare(
    `SELECT content FROM documents WHERE page_id = ? ORDER BY sort_order LIMIT 20`,
  );
  const update = db.prepare(
    `UPDATE pages
     SET publication_metadata = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND publication_metadata IS NULL`,
  );

  let updated = 0;
  const entries = pages.map((page) => {
    const existing = parsePublicationMetadata(page.publication_metadata);
    // ponytail: first 20 ordered chunks cover book front matter; widen only if
    // dry-run evidence shows a corpus whose imprint appears later.
    const content = (chunks.all(page.id) as ChunkRow[])
      .map((chunk) => chunk.content)
      .join("\n\n");
    const extraction = existing
      ? { publication: existing }
      : extractPublicationMetadata({ content });
    if (apply && !existing && extraction.publication) {
      updated += update.run(JSON.stringify(extraction.publication), page.id).changes;
    }
    return {
      pageId: page.id,
      library: page.library,
      title: page.title,
      url: page.url,
      status: existing
        ? "existing"
        : extraction.conflicts
          ? "conflict"
          : extraction.publication
            ? "found"
            : "missing",
      publication: extraction.publication ?? null,
      evidence: "evidence" in extraction ? (extraction.evidence ?? null) : null,
      conflicts: "conflicts" in extraction ? (extraction.conflicts ?? null) : null,
    };
  });

  const counts = entries.reduce<Record<string, number>>((result, entry) => {
    result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, {});
  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    database: path.basename(databasePath),
    libraryPrefix,
    pageCount: pages.length,
    updated,
    counts,
    entries,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ mode: report.mode, pageCount: pages.length, updated, counts })}\n`,
  );
} finally {
  db.close();
}

function requiredArg(name: string): string {
  const value = optionalArg(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function optionalArg(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
