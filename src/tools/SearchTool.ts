import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ArtifactCatalog } from "../contracts";
import { parseArtifactCatalog } from "../contracts";
import {
  LibraryNotFoundInStoreError,
  VersionNotFoundInStoreError,
} from "../store/errors";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import type { StoreSearchResult } from "../store/types";
import { logger } from "../utils/logger";
import {
  type PublicArtifactMetadata,
  toPublicArtifactMetadata,
} from "./ArtifactReferenceMetadata";
import { ToolError, ValidationError } from "./errors";

export interface SearchToolOptions {
  library: string;
  version?: string;
  query: string;
  limit?: number;
  exactMatch?: boolean;
}

export interface SearchToolResultError {
  message: string;
  availableVersions?: Array<{
    version: string;
    documentCount: number;
    uniqueUrlCount: number;
    indexedAt: string | null;
  }>;
  suggestions?: string[]; // Specific to LibraryNotFoundInStoreError
}

export interface SearchToolResult {
  results: StoreSearchResult[];
  matchedArtifacts?: MatchedArtifact[];
  relatedArtifacts?: RelatedArtifact[];
  relatedArtifactsSummary?: RelatedArtifactsSummary;
}

/** Read-only Artifact Catalog location used to enrich Search Results. */
export interface SearchArtifactConfig {
  root: string;
}

/** A Source Artifact whose representation contributed to one or more Search Results. */
export interface MatchedArtifact {
  artifactId: string;
  name: string;
  suggestedFilename: string;
  mediaType: string;
  availability: "Downloaded";
  process: {
    solutionId: string;
    processId: string;
    processName: string;
    lineOfBusiness: string[];
  };
  resourceLink: string;
  sizeBytes: number;
  searchResultIndexes: number[];
}

/** A Source Artifact from a matched process that did not contribute to a Search Result. */
export type RelatedArtifact = PublicArtifactMetadata & {
  process: MatchedArtifact["process"];
};

/** Related Artifact pagination facts for the bounded search response. */
export interface RelatedArtifactsSummary {
  total: number;
  returned: number;
  remaining: number;
  truncated: boolean;
}

const RELATED_ARTIFACT_LIMIT = 50;
const searchableProcessCatalogSchema = z
  .object({
    schemaVersion: z.literal("1"),
    library: z.string(),
    libraryVersion: z.string(),
    sourceRelease: z.string(),
    counts: z.unknown(),
    processCards: z.array(
      z
        .object({
          representationKey: z.string().trim().min(1),
          processId: z.string().trim().min(1),
        })
        .strict(),
    ),
    representations: z.array(z.unknown()),
  })
  .strict();

/**
 * Tool for searching indexed documentation.
 * Supports exact version matches and version range patterns.
 * Returns available versions when requested version is not found.
 */
export class SearchTool {
  private docService: Pick<
    IDocumentManagement,
    "validateLibraryExists" | "listLibraries" | "findBestVersion" | "searchStore"
  >;

  constructor(
    docService: Pick<
      IDocumentManagement,
      "validateLibraryExists" | "listLibraries" | "findBestVersion" | "searchStore"
    >,
    private readonly artifactConfig?: SearchArtifactConfig,
  ) {
    this.docService = docService;
  }

  async execute(options: SearchToolOptions): Promise<SearchToolResult> {
    const { library, version, query, limit = 5, exactMatch = false } = options;

    // Validate required inputs
    if (!library || typeof library !== "string" || library.trim() === "") {
      throw new ValidationError(
        "Library name is required and must be a non-empty string.",
        this.constructor.name,
      );
    }

    if (!query || typeof query !== "string" || query.trim() === "") {
      throw new ValidationError(
        "Query is required and must be a non-empty string.",
        this.constructor.name,
      );
    }

    if (limit !== undefined && (typeof limit !== "number" || limit < 1 || limit > 100)) {
      throw new ValidationError(
        "Limit must be a number between 1 and 100.",
        this.constructor.name,
      );
    }

    // Default to 'latest' only when exactMatch is false
    const resolvedVersion = version || "latest";

    logger.info(
      `🔍 Searching ${library}@${resolvedVersion}${exactMatch ? " (exact match)" : ""}`,
    );

    let failureStage = "library validation";
    try {
      // When exactMatch is true, version must be specified and not 'latest'
      if (exactMatch && (!version || version === "latest")) {
        await this.docService.validateLibraryExists(library);
        failureStage = "version resolution";
        const allLibraries = await this.docService.listLibraries();
        const libraryInfo = allLibraries.find((lib) => lib.library === library);
        const availableVersions = libraryInfo
          ? libraryInfo.versions.map((v) => v.ref.version)
          : [];
        throw new VersionNotFoundInStoreError(
          library,
          version ?? "latest",
          availableVersions,
        );
      }

      // 1. Validate library exists first
      await this.docService.validateLibraryExists(library);

      // 2. Proceed with version finding and searching
      let versionToSearch: string | null | undefined = resolvedVersion;

      if (!exactMatch) {
        failureStage = "version resolution";
        // If not exact match, find the best version (which might be null)
        const versionResult = await this.docService.findBestVersion(library, version);
        // Use the bestMatch from the result, which could be null
        versionToSearch = versionResult.bestMatch;

        // If findBestVersion returned null (no matching semver) AND unversioned docs exist,
        // should we search unversioned? The current logic passes null to searchStore,
        // which gets normalized to "" (unversioned). This seems reasonable.
        // If findBestVersion threw VersionNotFoundInStoreError, it's caught below.
      }
      // If exactMatch is true, versionToSearch remains the originally provided version.

      // Note: versionToSearch can be string | null | undefined here.
      // searchStore handles null/undefined by normalizing to "".
      failureStage = "document retrieval";
      const results = await this.docService.searchStore(
        library,
        versionToSearch,
        query,
        limit,
      );
      logger.info(`✅ Found ${results.length} matching results`);

      const enrichment = await this.findArtifactReferences(
        library,
        versionToSearch,
        results,
      );
      return enrichment ? { results, ...enrichment } : { results };
    } catch (error) {
      logger.error(`❌ Search failed during ${failureStage}`);
      if (
        error instanceof LibraryNotFoundInStoreError ||
        error instanceof VersionNotFoundInStoreError
      ) {
        throw error;
      }
      throw new ToolError(`Search failed during ${failureStage}`, this.constructor.name);
    }
  }

  private async findArtifactReferences(
    library: string,
    version: string | null | undefined,
    results: StoreSearchResult[],
  ): Promise<{
    matchedArtifacts: MatchedArtifact[];
    relatedArtifacts: RelatedArtifact[];
    relatedArtifactsSummary: RelatedArtifactsSummary;
  } | null> {
    const root = this.artifactConfig?.root;
    if (!root || !path.isAbsolute(root) || !version) {
      return null;
    }

    try {
      const versionRoot = path.resolve(root, library, version);
      if (!isContained(root, versionRoot)) {
        return null;
      }
      const catalog = parseArtifactCatalog(
        JSON.parse(
          await readFile(path.join(versionRoot, "artifact-catalog.json"), "utf8"),
        ),
      );
      if (catalog.library !== library || catalog.libraryVersion !== version) {
        return null;
      }

      const artifactsByRepresentation = new Map<
        string,
        Array<(typeof catalog.artifacts)[number] & { availability: "Downloaded" }>
      >();
      for (const artifact of catalog.artifacts) {
        if (artifact.availability !== "Downloaded") {
          continue;
        }
        for (const representationKey of artifact.indexedProvenance.representationKeys) {
          const representationPath = path.resolve(versionRoot, representationKey);
          if (!isContained(versionRoot, representationPath)) {
            continue;
          }
          const entries = artifactsByRepresentation.get(representationPath) ?? [];
          entries.push(artifact);
          artifactsByRepresentation.set(representationPath, entries);
        }
      }

      const matchedById = new Map<string, MatchedArtifact>();
      results.forEach((result, resultIndex) => {
        const resultPath = toContainedFilePath(result.url, versionRoot);
        if (!resultPath) {
          return;
        }
        for (const artifact of artifactsByRepresentation.get(resultPath) ?? []) {
          const existing = matchedById.get(artifact.artifactId);
          if (existing) {
            existing.searchResultIndexes.push(resultIndex);
            continue;
          }
          matchedById.set(artifact.artifactId, {
            artifactId: artifact.artifactId,
            name: artifact.name,
            suggestedFilename: artifact.blob.suggestedName,
            mediaType: artifact.blob.effectiveMime,
            availability: artifact.availability,
            process: artifact.process,
            resourceLink: `sap-artifact://${catalog.library}/${catalog.libraryVersion}/${artifact.artifactId}`,
            sizeBytes: artifact.blob.sizeBytes,
            searchResultIndexes: [resultIndex],
          });
        }
      });

      const matchedProcessKeys = await this.findProcessCardMatches(
        versionRoot,
        catalog,
        results,
      );
      for (const { process } of matchedById.values()) {
        matchedProcessKeys.add(processKey(process));
      }
      if (matchedProcessKeys.size === 0) {
        return null;
      }

      const relatedById = new Map<string, RelatedArtifact>();
      for (const artifact of catalog.artifacts) {
        if (
          matchedById.has(artifact.artifactId) ||
          !matchedProcessKeys.has(processKey(artifact.process)) ||
          relatedById.has(artifact.artifactId)
        ) {
          continue;
        }
        relatedById.set(artifact.artifactId, {
          ...toPublicArtifactMetadata(artifact, catalog.library, catalog.libraryVersion),
          process: artifact.process,
        });
      }

      const allRelatedArtifacts = [...relatedById.values()];
      const relatedArtifacts = allRelatedArtifacts.slice(0, RELATED_ARTIFACT_LIMIT);
      const remaining = allRelatedArtifacts.length - relatedArtifacts.length;
      return {
        matchedArtifacts: [...matchedById.values()],
        relatedArtifacts,
        relatedArtifactsSummary: {
          total: allRelatedArtifacts.length,
          returned: relatedArtifacts.length,
          remaining,
          truncated: remaining > 0,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          "⚠️ Matched Artifact enrichment skipped because its catalog is invalid",
        );
      }
      return null;
    }
  }

  private async findProcessCardMatches(
    versionRoot: string,
    artifactCatalog: ArtifactCatalog,
    results: StoreSearchResult[],
  ): Promise<Set<string>> {
    try {
      const searchableCatalog = searchableProcessCatalogSchema.parse(
        JSON.parse(
          await readFile(
            path.join(versionRoot, "searchable", "searchable-catalog.json"),
            "utf8",
          ),
        ) as unknown,
      );
      if (
        searchableCatalog.library !== artifactCatalog.library ||
        searchableCatalog.libraryVersion !== artifactCatalog.libraryVersion ||
        searchableCatalog.sourceRelease !== artifactCatalog.sourceRelease
      ) {
        return new Set();
      }

      const processKeysById = new Map<string, string>();
      const ambiguousProcessIds = new Set<string>();
      for (const artifact of artifactCatalog.artifacts) {
        const key = processKey(artifact.process);
        const existing = processKeysById.get(artifact.process.processId);
        if (existing && existing !== key) {
          ambiguousProcessIds.add(artifact.process.processId);
          processKeysById.delete(artifact.process.processId);
        } else if (!ambiguousProcessIds.has(artifact.process.processId)) {
          processKeysById.set(artifact.process.processId, key);
        }
      }

      const processKeysByRepresentation = new Map<string, string>();
      for (const card of searchableCatalog.processCards) {
        const key = processKeysById.get(card.processId);
        if (!key) {
          continue;
        }
        const representationPath = path.resolve(versionRoot, card.representationKey);
        if (!isContained(versionRoot, representationPath)) {
          continue;
        }
        processKeysByRepresentation.set(representationPath, key);
      }

      const matchedProcessKeys = new Set<string>();
      for (const result of results) {
        const resultPath = toContainedFilePath(result.url, versionRoot);
        const key = resultPath ? processKeysByRepresentation.get(resultPath) : undefined;
        if (key) {
          matchedProcessKeys.add(key);
        }
      }
      return matchedProcessKeys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          "⚠️ Process Card enrichment skipped because its searchable catalog is invalid",
        );
      }
      return new Set();
    }
  }
}

function processKey(process: { solutionId: string; processId: string }): string {
  return `${process.solutionId}\0${process.processId}`;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function toContainedFilePath(url: string, versionRoot: string): string | null {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "file:") {
    return null;
  }
  const filePath = path.resolve(fileURLToPath(parsedUrl));
  return isContained(versionRoot, filePath) ? filePath : null;
}
