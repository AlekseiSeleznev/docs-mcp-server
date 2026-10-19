import { parsePublicationMetadata } from "../publicationMetadata";
import type { AppConfig } from "../utils/config";
import { normalizeUrl } from "../utils/url";
import { createContentAssemblyStrategy } from "./assembly/ContentAssemblyStrategyFactory";
import type { DocumentStore } from "./DocumentStore";
import { AmbiguousPageInStoreError, PageNotFoundInStoreError } from "./errors";
import type {
  DbPageChunk,
  ListPagesOptions,
  ListPagesResult,
  PageContentOptions,
  PageContentResult,
} from "./types";

/** Upper bound on the pages listed when a path matches more than one. */
const MAX_AMBIGUOUS_PAGE_MATCHES = 10;

/**
 * Returns the distinct spellings a stored URL may use for `value`: as given,
 * encoded, and percent-decoded.
 */
function spellingsOf(value: string, encode: (value: string) => string): string[] {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding; the other spellings still apply.
  }
  return [...new Set([value, encode(value), decoded])];
}

/**
 * Percent-encodes a path the way URL parsing does when the scraper stores a URL.
 * Hash-only routes are left alone because they carry no path.
 */
function encodePath(path: string): string {
  if (!path.startsWith("/")) return path;
  const url = new URL(path, "http://placeholder");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Turns a page path into the URL ending to match: rooted at `/` (hash routes
 * excepted), without trailing slashes. Empty for the root path.
 */
function toPathSuffix(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") || trimmed.startsWith("#") ? trimmed : `/${trimmed}`;
}

/** Reads indexed pages using the same resolution and chunk windows on every transport. */
export class StoredPageReader {
  constructor(
    private readonly store: DocumentStore,
    private readonly appConfig: AppConfig,
    private readonly resolveVersion: (
      library: string,
      version: string | null | undefined,
    ) => Promise<{ library: string; version: string }>,
  ) {}

  /**
   * Reads consecutive chunks of a stored page, assembled for the page's content type.
   *
   * The page is identified by its URL, the URL its content was fetched from, or a
   * path matching the end of exactly one page URL. Only whole chunks are returned,
   * so the content never ends inside a code block; `nextChunk` tells the caller
   * where to continue.
   *
   * @param library Library name.
   * @param version Version or version range; resolved like `searchStore`.
   * @param pathOrUrl Page URL or path.
   * @param options `startChunk` to continue reading, `maxChars` to bound the size.
   * @returns The assembled window and its position within the page.
   * @throws PageNotFoundInStoreError when no page matches, with similar pages as suggestions.
   * @throws AmbiguousPageInStoreError when a path matches more than one page.
   */
  async getPageContent(
    library: string,
    version: string | null | undefined,
    pathOrUrl: string,
    options: PageContentOptions = {},
  ): Promise<PageContentResult> {
    const resolved = await this.resolvePageVersion(library, version);
    const url = await this.findPageUrl(resolved.library, resolved.version, pathOrUrl);
    const chunks = await this.store.findChunksByUrl(library, resolved.version, url);
    const contentType = chunks[0]?.content_type ?? null;
    const strategy = createContentAssemblyStrategy(contentType, this.appConfig);

    const startChunk = options.startChunk ?? 0;
    const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
    const window: DbPageChunk[] = [];
    for (const chunk of chunks.slice(startChunk)) {
      // The first chunk is always included so every call makes progress.
      if (
        window.length > 0 &&
        strategy.assembleContent([...window, chunk]).length > maxChars
      ) {
        break;
      }
      window.push(chunk);
    }
    const end = startChunk + window.length;

    return {
      url,
      publication: parsePublicationMetadata(chunks[0]?.publication_metadata),
      title: chunks[0]?.title ?? null,
      contentType,
      content: strategy.assembleContent(window),
      startChunk,
      totalChunks: chunks.length,
      nextChunk: end < chunks.length ? end : null,
    };
  }

  /**
   * Lists the stored pages of a library version.
   *
   * @param library Library name.
   * @param version Version or version range; resolved like `searchStore`.
   * @param options `contains` filters URLs; `limit` (default 50) and `offset` paginate.
   * @returns One page of results and whether more follow.
   */
  async listPages(
    library: string,
    version: string | null | undefined,
    options: ListPagesOptions = {},
  ): Promise<ListPagesResult> {
    const resolved = await this.resolvePageVersion(library, version);
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const { total, pages } = await this.store.listPages(library, resolved.version, {
      contains: options.contains,
      limit,
      offset,
    });
    return {
      library: resolved.library,
      version: resolved.version,
      total,
      pages,
      limit,
      offset,
      hasMore: offset + pages.length < total,
    };
  }

  /**
   * Validates the library and resolves the version label whose pages to read.
   * @returns The library's stored display name and the resolved version label.
   * @throws {LibraryNotFoundInStoreError} When the library does not exist (with suggestions).
   */
  private async resolvePageVersion(
    library: string,
    version: string | null | undefined,
  ): Promise<{ library: string; version: string }> {
    return this.resolveVersion(library, version);
  }

  /**
   * Resolves a page URL or path to the URL of exactly one stored page.
   * `library` is the stored display name, which the not-found and ambiguous
   * errors repeat.
   *
   * An absolute URL must equal a stored URL; a path must match the end of one.
   * Each is tried as given, spelled the way the scraper stores URLs, and decoded,
   * and then again without its fragment and query.
   */
  private async findPageUrl(
    library: string,
    version: string,
    pathOrUrl: string,
  ): Promise<string> {
    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(pathOrUrl);
    const withoutAnchor = pathOrUrl.replace(/[?#].*$/, "");

    for (const input of new Set([pathOrUrl, withoutAnchor])) {
      if (isAbsolute) {
        const [url] = await this.store.findPageUrls(
          library,
          version,
          spellingsOf(input, (value) => normalizeUrl(value, { removeHash: false })),
        );
        if (url) return url;
        continue;
      }

      const suffix = toPathSuffix(input);
      if (!suffix) continue;
      const urls = await this.store.findPageUrlsBySuffix(
        library,
        version,
        spellingsOf(suffix, encodePath),
        MAX_AMBIGUOUS_PAGE_MATCHES,
      );
      if (urls.length === 1) return urls[0];
      if (urls.length > 1) {
        throw new AmbiguousPageInStoreError(library, version, pathOrUrl, urls);
      }
    }

    throw new PageNotFoundInStoreError(
      library,
      version,
      pathOrUrl,
      await this.suggestPages(library, version, withoutAnchor),
    );
  }

  /**
   * Suggests up to three pages for input that matched none: pages whose URL
   * contains its last path segment, or else the top-level pages.
   */
  private async suggestPages(
    library: string,
    version: string,
    input: string,
  ): Promise<string[]> {
    const keyword = input.split("/").filter(Boolean).pop() ?? "";
    if (keyword.length >= 2) {
      const { pages } = await this.store.listPages(library, version, {
        contains: keyword,
        limit: 3,
      });
      if (pages.length > 0) return pages.map((page) => page.url);
    }
    const { pages } = await this.store.listPages(library, version, { limit: 3 });
    return pages.map((page) => page.url);
  }
}
