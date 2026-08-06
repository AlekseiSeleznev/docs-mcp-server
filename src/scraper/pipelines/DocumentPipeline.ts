/**
 * DocumentPipeline - Processes binary document formats using Xberg for text extraction,
 * then splits semantically.
 *
 * Supported formats:
 * - PDF (.pdf)
 * - Modern Office: Word (.docx), Excel (.xlsx), PowerPoint (.pptx)
 * - Legacy Office: Word (.doc), Excel (.xls), PowerPoint (.ppt)
 * - OpenDocument: Text (.odt), Spreadsheet (.ods), Presentation (.odp)
 * - Rich Text Format (.rtf)
 * - eBooks: EPUB (.epub), FictionBook (.fb2)
 * - Jupyter Notebook (.ipynb)
 *
 * The pipeline requests Markdown output from Xberg (`@xberg-io/xberg`) via
 * `outputFormat: OutputFormat.Markdown`, aligning with the project's Markdown-first
 * processing pipeline. Xberg's Markdown renderer emits fully structured output for
 * every format — including spreadsheets, where each sheet appears as a heading
 * followed by a Markdown table — so `content` is the preferred representation and
 * `tables[].markdown` only serves as a fallback when `content` comes back empty.
 *
 * Documents exceeding the configured maximum size are skipped with a warning.
 */

import {
  type ExtractedDocument,
  ExtractInputKind,
  extract,
  OutputFormat,
} from "@xberg-io/xberg";
import { GreedySplitter } from "../../splitter/GreedySplitter";
import { SemanticMarkdownSplitter } from "../../splitter/SemanticMarkdownSplitter";
import type { AppConfig } from "../../utils/config";
import { logger } from "../../utils/logger";
import { MimeTypeUtils } from "../../utils/mimeTypeUtils";
import type { RawContent } from "../fetcher/types";
import type { ScraperOptions } from "../types";
import { BasePipeline } from "./BasePipeline";
import type { PipelineResult } from "./types";

export class DocumentPipeline extends BasePipeline {
  private readonly splitter: GreedySplitter;
  private readonly maxSize: number;

  constructor(config: AppConfig) {
    super();
    this.maxSize = config.scraper.document.maxSize;

    const semanticSplitter = new SemanticMarkdownSplitter(
      config.splitter.preferredChunkSize,
      config.splitter.maxChunkSize,
    );
    this.splitter = new GreedySplitter(
      semanticSplitter,
      config.splitter.minChunkSize,
      config.splitter.preferredChunkSize,
      config.splitter.maxChunkSize,
    );
  }

  canProcess(mimeType: string): boolean {
    return MimeTypeUtils.isSupportedDocument(mimeType);
  }

  async process(
    rawContent: RawContent,
    _options: ScraperOptions,
  ): Promise<PipelineResult> {
    const buffer = Buffer.isBuffer(rawContent.content)
      ? rawContent.content
      : Buffer.from(rawContent.content);

    // Check size limit
    if (buffer.length > this.maxSize) {
      logger.warn(
        `Document exceeds size limit (${buffer.length} > ${this.maxSize}): ${rawContent.source}`,
      );
      return {
        title: null,
        contentType: rawContent.mimeType,
        textContent: null,
        links: [],
        errors: [new Error(`Document exceeds maximum size of ${this.maxSize} bytes`)],
        chunks: [],
      };
    }

    // Resolve the actual MIME type when the server sends a generic type.
    // This is common with S3, CDNs, and other file storage services that
    // serve documents as application/octet-stream.
    const mimeType = this.resolveMimeType(rawContent.mimeType, rawContent.source);
    if (!mimeType) {
      logger.warn(
        `Could not determine document type for ${rawContent.source} (MIME type: ${rawContent.mimeType})`,
      );
      return {
        title: null,
        contentType: rawContent.mimeType,
        textContent: null,
        links: [],
        errors: [new Error("Could not determine document type")],
        chunks: [],
      };
    }

    try {
      const result = await extract(
        { kind: ExtractInputKind.Bytes, bytes: buffer, mimeType },
        { outputFormat: OutputFormat.Markdown },
      );

      // `extract` returns an envelope that can carry several documents. A
      // single-input call yields at most one; a per-input failure is reported
      // in `errors` instead of throwing.
      const document = result.results?.[0];
      if (!document) {
        const reason = result.errors?.[0]?.message;
        throw new Error(
          reason
            ? `Extraction produced no result: ${reason}`
            : "Extraction produced no result",
        );
      }

      const content = this.extractContent(document);

      if (!content) {
        logger.warn(`No content extracted from document: ${rawContent.source}`);
        return {
          title: null,
          contentType: rawContent.mimeType,
          textContent: null,
          links: [],
          errors: [],
          chunks: [],
        };
      }

      // Use title from Xberg metadata, fall back to filename
      const title = document.metadata?.title || this.extractFilename(rawContent.source);

      // Split the content (Xberg output is Markdown)
      const chunks = await this.splitter.splitText(content, "text/markdown");

      return {
        title,
        contentType: "text/markdown", // Output is always markdown
        textContent: content,
        links: [], // Documents don't have extractable links
        errors: [],
        chunks,
      };
    } catch (error) {
      // Surface the underlying cause chain so environmental failures
      // (e.g. missing native bindings, glibc mismatches) are diagnosable
      // from the logs instead of silently dropping documents. Each cause's
      // message is truncated to keep potentially binary data out of logs.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const reasons = collectErrorReasons(error);
      const safeMessage = `Failed to convert document: ${errorName}`;
      const detail = reasons.length > 0 ? ` — ${reasons.join(" | ")}` : "";

      logger.error(`❌ ${safeMessage} (${mimeType}) for ${rawContent.source}${detail}`);

      return {
        title: null,
        contentType: rawContent.mimeType,
        textContent: null,
        links: [],
        errors: [new Error(safeMessage)],
        chunks: [],
      };
    }
  }

  /**
   * Selects the best content representation from an Xberg extraction result.
   *
   * `content` is preferred for every format: Xberg's Markdown renderer emits the
   * full document structure there, including sheet headings and Markdown tables
   * for spreadsheets, so it is always a superset of `tables[].markdown`. The
   * concatenated table Markdown is only used when `content` comes back empty.
   */
  private extractContent(document: ExtractedDocument): string | null {
    const content = document.content ?? "";
    if (content.trim().length > 0) {
      return content;
    }

    const tableContent = (document.tables ?? [])
      .map((t) => t.markdown ?? "")
      .filter((markdown) => markdown.trim().length > 0)
      .join("\n\n");

    return tableContent.length > 0 ? tableContent : null;
  }

  /**
   * Resolves the effective MIME type for document processing.
   * When the provided MIME type is generic (`application/octet-stream`), attempts to
   * detect the actual type from the source URL's file extension. Returns `null` if
   * the resolved type is not a supported document format.
   */
  private resolveMimeType(mimeType: string, source: string): string | null {
    if (mimeType !== "application/octet-stream") {
      return mimeType;
    }

    // detectMimeTypeFromPath handles query params and hash fragments internally
    const detected = MimeTypeUtils.detectMimeTypeFromPath(source);
    if (detected && MimeTypeUtils.isSupportedDocument(detected)) {
      return detected;
    }

    return null;
  }

  private extractFilename(source: string): string | null {
    try {
      const url = new URL(source);
      const pathname = url.pathname;
      const lastSlash = pathname.lastIndexOf("/");
      return pathname.substring(lastSlash + 1) || null;
    } catch {
      const lastSlash = source.lastIndexOf("/");
      return source.substring(lastSlash + 1) || null;
    }
  }
}

/**
 * Maximum length (in characters) of any single error message included in
 * extraction failure logs. Xberg errors may embed parts of the input
 * document; truncating defends the logs against accidental binary dumps
 * while still surfacing enough text to diagnose the root cause.
 */
const MAX_ERROR_DETAIL_LENGTH = 500;

/**
 * Walks an `Error.cause` chain and returns a deduplicated, truncated list
 * of each link's `message`. Used to surface the underlying cause of a
 * Xberg extraction failure (e.g. "GLIBC_2.38 not found") rather than
 * just the wrapper's generic name.
 */
function collectErrorReasons(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;
  while (current && !seen.has(current) && depth < 10) {
    seen.add(current);
    if (current instanceof Error && current.message) {
      const trimmed = current.message
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_ERROR_DETAIL_LENGTH);
      if (trimmed && !messages.includes(trimmed)) {
        messages.push(trimmed);
      }
    }
    current = (current as { cause?: unknown }).cause;
    depth++;
  }
  return messages;
}
