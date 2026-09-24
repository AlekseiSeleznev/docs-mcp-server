import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StoreSearchResult } from "../store/types";

/** Formats search results consistently for full and read-only MCP servers. */
export function formatSearchResults(
  results: Pick<StoreSearchResult, "url" | "content" | "publication">[],
): string[] {
  return results.map((result, index) => {
    const publicationLines = [
      result.publication?.authors?.length
        ? `Publication authors: ${result.publication.authors.join("; ")}`
        : null,
      result.publication?.year ? `Publication year: ${result.publication.year}` : null,
    ].filter((line): line is string => Boolean(line));
    const publication =
      publicationLines.length > 0 ? `\n${publicationLines.join("\n")}\n` : "";
    return `
------------------------------------------------------------
Result ${index + 1}: ${result.url}
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
