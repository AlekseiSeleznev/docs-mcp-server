import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScrapeResult } from "../scraper/types";
import { DocumentStore } from "../store/DocumentStore";
import { ReadOnlyDocumentManagementService } from "../store/ReadOnlyDocumentManagementService";
import { loadConfig } from "../utils/config";
import { createReadOnlyMcpServer } from "./readOnlyMcpServer";
import { initializeReadOnlyTools } from "./readOnlyTools";

function page(url: string, chunks = ["Stored fixture content"]): ScrapeResult {
  return {
    url,
    title: "Fixture [page]",
    sourceContentType: "text/markdown",
    contentType: "text/markdown",
    textContent: chunks.join("\n\n"),
    links: [],
    errors: [],
    chunks: chunks.map((content) => ({
      content,
      types: ["text"],
      section: { level: 1, path: ["Fixture"] },
    })),
    publication: { authors: ["Jane Doe"], year: 2024 },
  };
}

function hash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("packaged read-only page tools against SQLite", () => {
  let directory: string;
  let service: ReadOnlyDocumentManagementService;
  let server: ReturnType<typeof createReadOnlyMcpServer>;
  let client: Client;
  let before: string;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "docs-desktop-pages-"));
    const config = loadConfig({ storePath: directory, embeddingModel: "" });
    const writable = new DocumentStore(path.join(directory, "documents.db"), config);
    await writable.initialize();
    await writable.addDocuments(
      "Books",
      "stable",
      0,
      page("https://example.com/a/guide", [
        "FIRST WHOLE CHUNK",
        "SECOND WHOLE CHUNK",
        "THIRD WHOLE CHUNK",
      ]),
    );
    await writable.addDocuments(
      "Books",
      "stable",
      1,
      page("https://example.com/b/guide"),
    );
    await writable.addDocuments(
      "Books",
      "stable",
      2,
      page("https://example.com/chapter"),
    );
    await writable.addDocuments(
      "Versioned",
      "1.20",
      0,
      page("https://example.com/partial"),
    );
    await writable.addDocuments(
      "Versioned",
      "2.0.0-beta",
      0,
      page("https://example.com/prerelease"),
    );
    await writable.shutdown();
    before = hash(path.join(directory, "documents.db"));
    service = new ReadOnlyDocumentManagementService(config);
    await service.initialize();
    server = createReadOnlyMcpServer(initializeReadOnlyTools(service));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "desktop-pages-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await service?.shutdown();
    expect(hash(path.join(directory, "documents.db"))).toBe(before);
    rmSync(directory, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return { ...result, text };
  }

  it("lists and continues only matching indexed pages", async () => {
    const first = await call("list_pages", {
      library: "books",
      contains: "guide",
      limit: 1,
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("Books@stable (2 total pages, showing 1-1)");
    expect(first.text).toContain("https://example.com/a/guide");
    expect(first.text).not.toContain("https://example.com/b/guide");
    expect(first.text).toContain("Use offset: 1");
    const next = await call("list_pages", {
      library: "books",
      contains: "guide",
      limit: 1,
      offset: 1,
    });
    expect(next.text).toContain("https://example.com/b/guide");
    expect(next.text).not.toContain("Use offset:");
  });

  it("reads whole chunks and continues with metadata on each window", async () => {
    const first = await call("read_page", {
      library: "books",
      pathOrUrl: "a/guide",
      maxChars: 1,
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("FIRST WHOLE CHUNK");
    expect(first.text).not.toContain("SECOND WHOLE CHUNK");
    expect(first.text).toContain("startChunk: 1");
    expect(first.text).toContain("Publication authors: Jane Doe");
    expect(first.text).toContain("Publication year: 2024");
    const next = await call("read_page", {
      library: "books",
      pathOrUrl: "a/guide",
      maxChars: 1,
      startChunk: 1,
    });
    expect(next.text).toContain("SECOND WHOLE CHUNK");
    expect(next.text).not.toContain("FIRST WHOLE CHUNK");
    expect(next.text).toContain("Publication authors: Jane Doe");
    expect(next.text).toContain("startChunk: 2");
    const end = await call("read_page", {
      library: "books",
      pathOrUrl: "a/guide",
      startChunk: 2,
    });
    expect(end.text).toContain("THIRD WHOLE CHUNK");
    expect(end.text).not.toContain("To continue");
  });

  it("asks for a full indexed URL when a suffix is ambiguous", async () => {
    const result = await call("read_page", { library: "books", pathOrUrl: "guide" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("matches more than one page");
    expect(result.text).toContain("https://example.com/a/guide");
    expect(result.text).toContain("https://example.com/b/guide");
  });

  it("reports missing absolute URLs from the store without fetching them", async () => {
    const result = await call("read_page", {
      library: "books",
      pathOrUrl: "http://127.0.0.1:1/not-indexed",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not found in store");
  });

  it("uses partial and prerelease labels through the same version ladder", async () => {
    const partial = await call("list_pages", { library: "versioned", version: "1.x" });
    expect(partial.text).toContain("Versioned@1.20");
    const latest = await call("read_page", {
      library: "versioned",
      pathOrUrl: "prerelease",
    });
    expect(latest.isError).toBe(false);
    expect(latest.text).toContain("https://example.com/prerelease");
  });

  it("rejects write and arbitrary-fetch tools", async () => {
    const definitions = await client.listTools();
    expect(definitions.tools.map(({ name }) => name).sort()).toEqual([
      "find_version",
      "list_libraries",
      "list_pages",
      "read_page",
      "search_docs",
    ]);
    for (const name of ["scrape_docs", "remove_docs", "fetch_url"]) {
      expect((await call(name, {})).isError).toBe(true);
    }
  });
});
