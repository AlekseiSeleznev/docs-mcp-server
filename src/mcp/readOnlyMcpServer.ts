import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { MCPB_VERSION } from "../build/mcpb";
import { formatPageContent, formatPageList } from "./pageResponses";
import type { ReadOnlyMcpTools } from "./tools";
import { createError, createResponse, formatSearchResults } from "./utils";

/** Creates the minimal read-only MCP server used by packaged desktop extensions. */
export function createReadOnlyMcpServer(tools: ReadOnlyMcpTools): McpServer {
  const server = new McpServer(
    {
      name: "lib-docs",
      version: MCPB_VERSION,
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.tool(
    "search_docs",
    "Search indexed documentation for a library or package.",
    {
      library: z.string().trim().describe("Library name."),
      version: z
        .string()
        .trim()
        .optional()
        .describe("Library version (exact or X-Range, optional)."),
      query: z.string().trim().describe("Documentation search query."),
      limit: z.number().optional().default(5).describe("Maximum number of results."),
    },
    {
      title: "Search Library Documentation",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ library, version, query, limit }) => {
      try {
        const result = await tools.search.execute({
          library,
          version,
          query,
          limit,
          exactMatch: false,
        });
        const formattedResults = formatSearchResults(result.results);
        return formattedResults.length === 0
          ? createResponse(
              `No results found for '${query}' in ${library}. Try to use a different or more general query.`,
            )
          : createResponse(formattedResults.join(""));
      } catch {
        return createError("Search failed");
      }
    },
  );

  server.tool(
    "list_libraries",
    "List all indexed libraries.",
    {},
    {
      title: "List Libraries",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async () => {
      try {
        const result = await tools.listLibraries.execute();
        return result.libraries.length === 0
          ? createResponse("No libraries indexed yet.")
          : createResponse(
              `Indexed libraries:\n\n${result.libraries
                .map((library: { name: string }) => `- ${library.name}`)
                .join("\n")}`,
            );
      } catch (error) {
        return createError(error);
      }
    },
  );

  server.tool(
    "find_version",
    "Find the best matching version for an indexed library.",
    {
      library: z.string().trim().describe("Library name."),
      targetVersion: z
        .string()
        .trim()
        .optional()
        .describe("Version pattern to match (exact or X-Range, optional)."),
    },
    {
      title: "Find Library Version",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ library, targetVersion }) => {
      try {
        const result = await tools.findVersion.execute({ library, targetVersion });
        return createResponse(result.message);
      } catch (error) {
        return createError(error);
      }
    },
  );

  server.tool(
    "list_pages",
    "List indexed pages of a library version, with optional URL filtering and pagination.",
    {
      library: z.string().trim().describe("Library name."),
      version: z
        .string()
        .trim()
        .optional()
        .describe("Library version or range (optional)."),
      contains: z
        .string()
        .trim()
        .optional()
        .describe("Filter URLs containing this text."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum pages (default 50, max 200)."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Number of pages to skip."),
    },
    {
      title: "List Library Pages",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (options) => {
      try {
        const result = await tools.listPages.execute(options);
        return createResponse(formatPageList(result, options.library, options.contains));
      } catch (error) {
        return createError(error);
      }
    },
  );

  server.tool(
    "read_page",
    "Read an indexed documentation page returned by search_docs or list_pages. Continue long pages using startChunk from the response.",
    {
      library: z.string().trim().describe("Library name."),
      pathOrUrl: z
        .string()
        .trim()
        .min(1)
        .describe("Indexed page URL or an unambiguous suffix of its path."),
      version: z
        .string()
        .trim()
        .optional()
        .describe("Library version or range (optional)."),
      startChunk: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Chunk index to start from."),
      maxChars: z
        .number()
        .positive()
        .optional()
        .default(30000)
        .describe(
          "Maximum characters (whole chunks only; a single longer chunk is returned on its own).",
        ),
    },
    {
      title: "Read Documentation Page",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (options) => {
      try {
        return createResponse(formatPageContent(await tools.readPage.execute(options)));
      } catch (error) {
        return createError(error);
      }
    },
  );

  return server;
}
