import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PublicationMetadata } from "../publicationMetadata";
import type { StoreSearchResult } from "../store/types";

/** Formats recorded authors and year for search excerpts and full-page reads. */
export function formatPublicationMetadata(publication?: PublicationMetadata): string[] {
  return [
    publication?.authors?.length
      ? `Publication authors: ${publication.authors.join("; ")}`
      : null,
    publication?.year ? `Publication year: ${publication.year}` : null,
  ].filter((line): line is string => Boolean(line));
}

/** Formats search results consistently for full and read-only MCP servers. */
export function formatSearchResults(
  results: Pick<StoreSearchResult, "url" | "contentUrl" | "content" | "publication">[],
): string[] {
  return results.map((result, index) => {
    const publicationLines = formatPublicationMetadata(result.publication);
    const publication =
      publicationLines.length > 0 ? `\n${publicationLines.join("\n")}\n` : "";
    return `
------------------------------------------------------------
Result ${index + 1}: ${result.contentUrl ?? result.url}
${publication}
${result.content}\n`;
  });
}

/**
 * Creates a success response object in the format expected by the MCP server.
 * @param text The text content of the response.
 * @returns The response object.
 */
export function createResponse(text: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: false,
  };
}

/**
 * Creates an error response object in the format expected by the MCP server.
 * @param text The error message.
 * @returns The response object.
 */
export function createError(errorOrText: unknown): CallToolResult {
  const text = errorOrText instanceof Error ? errorOrText.message : String(errorOrText);
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: true,
  };
}
