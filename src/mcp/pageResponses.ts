import type { ListPagesResult, PageContentResult } from "../store/types";
import { formatPublicationMetadata } from "./utils";

/** Formats one stored-page window, including the next whole chunk to read. */
export function formatPageContent(result: PageContentResult): string {
  if (result.startChunk >= result.totalChunks && result.totalChunks > 0) {
    return `startChunk ${result.startChunk} is past the end of ${result.url}, which has ${result.totalChunks} chunks.`;
  }

  const end = result.nextChunk ?? result.totalChunks;
  const notice =
    result.nextChunk !== null
      ? `\n\n> Showing chunks ${result.startChunk + 1}-${end} of ${result.totalChunks}. ` +
        `To continue, call read_page again with startChunk: ${result.nextChunk}.`
      : "";

  const publication = formatPublicationMetadata(result.publication);
  const metadata = publication.length > 0 ? `\n${publication.join("\n")}\n` : "";
  return `> Source: ${result.url}\n${metadata}\n${result.content}${notice}`;
}

/** Formats an indexed-page listing with its continuation offset. */
export function formatPageList(
  result: ListPagesResult,
  library: string,
  contains?: string,
): string {
  if (result.pages.length === 0) {
    return `No pages found for '${library}'${result.version ? `@${result.version}` : ""}${contains ? ` with URLs containing '${contains}'` : ""}.`;
  }

  const lines = result.pages.map((p) => {
    const safeTitle = (p.title || p.url).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    return `- [${safeTitle}](<${p.url}>)${p.depth !== null ? ` (depth: ${p.depth})` : ""}`;
  });

  let responseText = `Indexed pages for ${result.library}${result.version ? `@${result.version}` : ""} (${result.total} total pages, showing ${result.offset + 1}-${result.offset + result.pages.length}):\n\n${lines.join("\n")}`;

  if (result.hasMore) {
    responseText += `\n\nUse offset: ${result.offset + result.pages.length} to see the next batch of pages.`;
  }

  return responseText;
}
