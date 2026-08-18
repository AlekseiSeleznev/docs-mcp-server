import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createArtifactId } from "../contracts";
import {
  type DocumentManagementService,
  LibraryNotFoundInStoreError,
  VersionNotFoundInStoreError,
} from "../store";
import type { StoreSearchResult } from "../store/types";
import { logger } from "../utils/logger";
import { SearchTool, type SearchToolOptions } from "./SearchTool";

const artifactLibrary = "sap_process_navigator";
const artifactVersion = "2025.1.0";

function makeCatalogArtifact(
  processId: string,
  name: string,
  availability: "Downloaded" | "Missing" | "ExternalUnresolved",
  representationKeys: string[] = [],
) {
  const canonicalRelativePath = `source/${processId}/${name}`;
  const sha256 = createHash("sha256").update(`${processId}:${name}`).digest("hex");
  const artifactBase = {
    artifactId: createArtifactId({
      library: artifactLibrary,
      libraryVersion: artifactVersion,
      solutionId: "EARL_SolS-055",
      processId,
      canonicalRelativePath,
      ...(availability === "Downloaded" ? { availability, sha256 } : { availability }),
    }),
    process: {
      solutionId: "EARL_SolS-055",
      processId,
      processName: `Process ${processId}`,
      lineOfBusiness: ["Sourcing and Procurement"],
    },
    canonicalRelativePath,
    type: name.endsWith(".bpmn") ? "BPMN" : "Document",
    group: "Process",
    name,
    availability,
  };
  return availability === "Downloaded"
    ? {
        ...artifactBase,
        availability,
        blob: {
          originalName: name,
          suggestedName: name,
          manifestMime: "application/octet-stream",
          effectiveMime: "application/octet-stream",
          sizeBytes: 1,
          sha256,
          storageKey: canonicalRelativePath,
        },
        indexedProvenance: { representationKeys },
      }
    : artifactBase;
}

// Mock dependencies

vi.mock("../utils/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("SearchTool", () => {
  let mockDocService: Partial<DocumentManagementService>;
  let searchTool: SearchTool;

  beforeEach(() => {
    vi.resetAllMocks();

    mockDocService = {
      validateLibraryExists: vi.fn(),
      findBestVersion: vi.fn(),
      searchStore: vi.fn(),
      listVersions: vi.fn(),
      listLibraries: vi.fn(),
    };

    searchTool = new SearchTool(mockDocService as DocumentManagementService);
  });

  const baseOptions: Omit<SearchToolOptions, "version" | "exactMatch" | "limit"> = {
    library: "test-lib",
    query: "test query",
  };

  const mockSearchResults: StoreSearchResult[] = [
    {
      url: "http://example.com/page1",
      content: "Content for result 1",
      score: 0.9,
    },
    {
      url: "http://example.com/page2",
      content: "Content for result 2",
      score: 0.8,
    },
  ];

  // --- Search Logic & Version Resolution Tests ---

  it("should search with exact version when exactMatch is true", async () => {
    const options: SearchToolOptions = {
      ...baseOptions,
      version: "1.0.0",
      exactMatch: true,
    };
    (mockDocService.searchStore as Mock).mockResolvedValue(mockSearchResults);

    const result = await searchTool.execute(options);

    expect(mockDocService.findBestVersion).not.toHaveBeenCalled();
    expect(mockDocService.searchStore).toHaveBeenCalledWith(
      "test-lib",
      "1.0.0", // Exact version
      "test query",
      5, // Default limit
    );
    expect(result.results).toEqual(mockSearchResults);
  });

  it("should throw VersionNotFoundInStoreError when exactMatch is true but no version is specified", async () => {
    const options: SearchToolOptions = {
      ...baseOptions,
      exactMatch: true,
    };
    // Mock listLibraries for this specific test case
    const mockLibraryDetails = [
      {
        library: "test-lib",
        versions: [
          {
            id: 1,
            ref: { library: "test-lib", version: "1.0.0" },
            status: "NOT_INDEXED",
            progress: { pages: 0, maxPages: 1 },
            counts: { documents: 1, uniqueUrls: 1 },
            indexedAt: "2024-01-01T00:00:00Z",
            sourceUrl: null,
          },
        ],
      },
    ];
    (mockDocService.validateLibraryExists as Mock).mockResolvedValue(undefined);
    (mockDocService.listLibraries as Mock).mockResolvedValue(mockLibraryDetails); // Mock listLibraries call

    await expect(searchTool.execute(options)).rejects.toThrow(
      "Version latest for library test-lib not found in store",
    );
    expect(mockDocService.validateLibraryExists).toHaveBeenCalledWith("test-lib");
    expect(mockDocService.listLibraries).toHaveBeenCalled(); // Expect listLibraries now
    expect(mockDocService.listVersions).not.toHaveBeenCalled(); // Should not be called here
    expect(mockDocService.searchStore).not.toHaveBeenCalled();
  });

  it("should throw VersionNotFoundInStoreError when exactMatch is true with 'latest' version", async () => {
    const options: SearchToolOptions = {
      ...baseOptions,
      version: "latest",
      exactMatch: true,
    };
    // Mock listLibraries for this specific test case
    const mockLibraryDetails = [
      {
        library: "test-lib",
        versions: [
          {
            id: 1,
            ref: { library: "test-lib", version: "1.0.0" },
            status: "NOT_INDEXED",
            progress: { pages: 0, maxPages: 1 },
            counts: { documents: 1, uniqueUrls: 1 },
            indexedAt: "2024-01-01T00:00:00Z",
            sourceUrl: null,
          },
        ],
      },
    ];
    (mockDocService.validateLibraryExists as Mock).mockResolvedValue(undefined);
    (mockDocService.listLibraries as Mock).mockResolvedValue(mockLibraryDetails); // Mock listLibraries call

    await expect(searchTool.execute(options)).rejects.toThrow(
      "Version latest for library test-lib not found in store",
    );
    expect(mockDocService.validateLibraryExists).toHaveBeenCalledWith("test-lib");
    expect(mockDocService.listLibraries).toHaveBeenCalled(); // Expect listLibraries now
    expect(mockDocService.listVersions).not.toHaveBeenCalled(); // Should not be called here
    expect(mockDocService.searchStore).not.toHaveBeenCalled();
  });

  it("should find best version and search when exactMatch is false (default)", async () => {
    const options: SearchToolOptions = { ...baseOptions, version: "1.x" };
    const findVersionResult = { bestMatch: "1.2.0", hasUnversioned: false };
    (mockDocService.findBestVersion as Mock).mockResolvedValue(findVersionResult);
    (mockDocService.searchStore as Mock).mockResolvedValue(mockSearchResults);

    const result = await searchTool.execute(options);

    expect(mockDocService.findBestVersion).toHaveBeenCalledWith("test-lib", "1.x");
    expect(mockDocService.searchStore).toHaveBeenCalledWith(
      "test-lib",
      "1.2.0", // Best matched version
      "test query",
      5,
    );
    expect(result.results).toEqual(mockSearchResults);
  });

  it("should search unversioned docs if findBestVersion returns null bestMatch but hasUnversioned", async () => {
    const options: SearchToolOptions = { ...baseOptions, version: "2.0.0" }; // Version doesn't exist
    const findVersionResult = { bestMatch: null, hasUnversioned: true };
    (mockDocService.findBestVersion as Mock).mockResolvedValue(findVersionResult);
    (mockDocService.searchStore as Mock).mockResolvedValue(mockSearchResults); // Assume searchStore handles null/"" correctly

    const result = await searchTool.execute(options);

    expect(mockDocService.findBestVersion).toHaveBeenCalledWith("test-lib", "2.0.0");
    // searchStore receives null, which it should normalize to "" for unversioned search
    expect(mockDocService.searchStore).toHaveBeenCalledWith(
      "test-lib",
      null,
      "test query",
      5,
    );
    expect(result.results).toEqual(mockSearchResults);
  });

  it("should use 'latest' for findBestVersion if version is omitted and exactMatch is false", async () => {
    const options: SearchToolOptions = { ...baseOptions }; // No version
    const findVersionResult = { bestMatch: "1.2.0", hasUnversioned: false };
    (mockDocService.findBestVersion as Mock).mockResolvedValue(findVersionResult);
    (mockDocService.searchStore as Mock).mockResolvedValue(mockSearchResults);

    await searchTool.execute(options);

    // The implementation passes undefined, which is defaulted to "latest" in the method
    expect(mockDocService.findBestVersion).toHaveBeenCalledWith("test-lib", undefined);
    expect(mockDocService.searchStore).toHaveBeenCalledWith(
      "test-lib",
      "1.2.0",
      "test query",
      5,
    );
  });

  // --- Limit Handling ---

  it("should use the specified limit", async () => {
    const options: SearchToolOptions = {
      ...baseOptions,
      version: "1.0.0",
      exactMatch: true,
      limit: 10,
    };
    (mockDocService.searchStore as Mock).mockResolvedValue([]);

    await searchTool.execute(options);

    expect(mockDocService.searchStore).toHaveBeenCalledWith(
      "test-lib",
      "1.0.0",
      "test query",
      10, // Specified limit
    );
  });

  it("maps Search Results to deduplicated occurrence-specific Matched Artifacts", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "matched-artifacts-"));
    const library = "sap_process_navigator";
    const version = "2025.1.0";
    const versionRoot = path.join(artifactRoot, library, version);
    const firstRepresentation = "searchable/2xu/source.md";
    const secondRepresentation = "searchable/3xu/source.md";
    const sharedBytesHash = createHash("sha256").update("same bytes").digest("hex");
    const makeArtifact = (processId: string, representationKey: string) => {
      const canonicalRelativePath = `source/${processId}/source.bpmn`;
      return {
        artifactId: createArtifactId({
          library,
          libraryVersion: version,
          solutionId: "EARL_SolS-055",
          processId,
          canonicalRelativePath,
          availability: "Downloaded",
          sha256: sharedBytesHash,
        }),
        process: {
          solutionId: "EARL_SolS-055",
          processId,
          processName: `Process ${processId}`,
          lineOfBusiness: ["Sourcing and Procurement"],
        },
        canonicalRelativePath,
        type: "BPMN",
        group: "Process",
        name: `Source model ${processId}`,
        availability: "Downloaded" as const,
        blob: {
          originalName: "source.bpmn",
          suggestedName: `${processId}.bpmn`,
          manifestMime: "application/xml",
          effectiveMime: "application/xml",
          sizeBytes: 10,
          sha256: sharedBytesHash,
          storageKey: canonicalRelativePath,
        },
        indexedProvenance: { representationKeys: [representationKey] },
      };
    };
    const firstArtifact = makeArtifact("2XU", firstRepresentation);
    const secondArtifact = makeArtifact("3XU", secondRepresentation);

    try {
      await mkdir(path.join(versionRoot, "searchable", "2xu"), { recursive: true });
      await mkdir(path.join(versionRoot, "searchable", "3xu"), { recursive: true });
      await writeFile(
        path.join(versionRoot, "artifact-catalog.json"),
        JSON.stringify({
          catalogVersion: "1",
          library,
          libraryVersion: version,
          sourceRelease: "2025-FPS1-RU",
          artifacts: [firstArtifact, secondArtifact],
        }),
      );
      await writeFile(path.join(versionRoot, firstRepresentation), "first");
      await writeFile(path.join(versionRoot, secondRepresentation), "second");
      const searchResults: StoreSearchResult[] = [
        {
          url: pathToFileURL(path.join(versionRoot, firstRepresentation)).href,
          content: "first candidate",
          score: 0.9,
        },
        {
          url: pathToFileURL(path.join(versionRoot, firstRepresentation)).href,
          content: "repeated candidate",
          score: 0.8,
        },
        {
          url: pathToFileURL(path.join(versionRoot, secondRepresentation)).href,
          content: "same bytes, different process",
          score: 0.7,
        },
      ];
      (mockDocService.searchStore as Mock).mockResolvedValue(searchResults);
      const catalogBackedSearch = new SearchTool(
        mockDocService as DocumentManagementService,
        { root: artifactRoot },
      );

      const result = await catalogBackedSearch.execute({
        library,
        version,
        exactMatch: true,
        query: "source",
      });

      expect(result.results).toEqual(searchResults);
      expect(result.matchedArtifacts).toEqual([
        expect.objectContaining({
          artifactId: firstArtifact.artifactId,
          suggestedFilename: "2XU.bpmn",
          mediaType: "application/xml",
          availability: "Downloaded",
          process: firstArtifact.process,
          searchResultIndexes: [0, 1],
        }),
        expect.objectContaining({
          artifactId: secondArtifact.artifactId,
          process: secondArtifact.process,
          searchResultIndexes: [2],
        }),
      ]);
      expect(result.matchedArtifacts?.map(({ artifactId }) => artifactId)).toEqual([
        firstArtifact.artifactId,
        secondArtifact.artifactId,
      ]);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("returns process-only and unavailable artifacts as deduplicated Related Artifacts", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "related-artifacts-"));
    const versionRoot = path.join(artifactRoot, artifactLibrary, artifactVersion);
    const representationKey = "searchable/2xu/source.md";
    const matched = makeCatalogArtifact("2XU", "source.bpmn", "Downloaded", [
      representationKey,
    ]);
    const secondMatch = makeCatalogArtifact("2XU", "description.txt", "Downloaded", [
      representationKey,
    ]);
    const related = makeCatalogArtifact("2XU", "test-script.docx", "Downloaded", [
      "searchable/2xu/test-script.md",
    ]);
    const missing = makeCatalogArtifact("2XU", "missing.pdf", "Missing");
    const unresolved = makeCatalogArtifact("2XU", "external.xlsx", "ExternalUnresolved");
    const otherProcess = makeCatalogArtifact("3XU", "other.bpmn", "Downloaded", [
      "searchable/3xu/source.md",
    ]);

    try {
      await mkdir(path.join(versionRoot, "searchable", "2xu"), { recursive: true });
      await writeFile(
        path.join(versionRoot, "artifact-catalog.json"),
        JSON.stringify({
          catalogVersion: "1",
          library: artifactLibrary,
          libraryVersion: artifactVersion,
          sourceRelease: "2025-FPS1-RU",
          artifacts: [matched, secondMatch, related, missing, unresolved, otherProcess],
        }),
      );
      const representationPath = path.join(versionRoot, representationKey);
      await writeFile(representationPath, "matched");
      (mockDocService.searchStore as Mock).mockResolvedValue([
        { url: pathToFileURL(representationPath).href, content: "candidate", score: 1 },
      ]);

      const result = await new SearchTool(mockDocService as DocumentManagementService, {
        root: artifactRoot,
      }).execute({
        library: artifactLibrary,
        version: artifactVersion,
        exactMatch: true,
        query: "source",
      });

      expect(result.matchedArtifacts?.map((artifact) => artifact.artifactId)).toEqual([
        matched.artifactId,
        secondMatch.artifactId,
      ]);
      expect(result.relatedArtifacts).toEqual([
        expect.objectContaining({
          artifactId: related.artifactId,
          availability: "Downloaded",
          resourceLink: expect.stringContaining(related.artifactId),
        }),
        {
          artifactId: missing.artifactId,
          availability: "Missing",
          group: "Process",
          name: "missing.pdf",
          process: missing.process,
          type: "Document",
        },
        {
          artifactId: unresolved.artifactId,
          availability: "ExternalUnresolved",
          group: "Process",
          name: "external.xlsx",
          process: unresolved.process,
          type: "Document",
        },
      ]);
      expect(JSON.stringify(result.relatedArtifacts)).not.toContain("blob");
      expect(
        result.relatedArtifacts?.map((artifact) => artifact.artifactId),
      ).not.toContain(matched.artifactId);
      expect(result.relatedArtifactsSummary).toEqual({
        total: 3,
        returned: 3,
        remaining: 0,
        truncated: false,
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("caps Related Artifacts globally at 50 and reports total and remaining", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "related-artifact-cap-"));
    const versionRoot = path.join(artifactRoot, artifactLibrary, artifactVersion);
    const representationKey = "searchable/2xu/source.md";
    const matched = makeCatalogArtifact("2XU", "source.bpmn", "Downloaded", [
      representationKey,
    ]);
    const related = Array.from({ length: 55 }, (_, index) =>
      makeCatalogArtifact("2XU", `related-${index}.pdf`, "Missing"),
    );

    try {
      await mkdir(path.join(versionRoot, "searchable", "2xu"), { recursive: true });
      await writeFile(
        path.join(versionRoot, "artifact-catalog.json"),
        JSON.stringify({
          catalogVersion: "1",
          library: artifactLibrary,
          libraryVersion: artifactVersion,
          sourceRelease: "2025-FPS1-RU",
          artifacts: [matched, ...related],
        }),
      );
      const representationPath = path.join(versionRoot, representationKey);
      await writeFile(representationPath, "matched");
      (mockDocService.searchStore as Mock).mockResolvedValue([
        { url: pathToFileURL(representationPath).href, content: "candidate", score: 1 },
      ]);

      const result = await new SearchTool(mockDocService as DocumentManagementService, {
        root: artifactRoot,
      }).execute({
        library: artifactLibrary,
        version: artifactVersion,
        exactMatch: true,
        query: "source",
      });

      expect(result.relatedArtifacts).toHaveLength(50);
      expect(result.relatedArtifactsSummary).toEqual({
        total: 55,
        returned: 50,
        remaining: 5,
        truncated: true,
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps catalog-less search output text-only", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "catalog-less-search-"));
    (mockDocService.searchStore as Mock).mockResolvedValue(mockSearchResults);
    const catalogLessSearch = new SearchTool(
      mockDocService as DocumentManagementService,
      { root: artifactRoot },
    );

    try {
      await expect(
        catalogLessSearch.execute({
          ...baseOptions,
          version: "1.0.0",
          exactMatch: true,
        }),
      ).resolves.toEqual({ results: mockSearchResults });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  // --- Error Handling & Result Structure ---

  it("should throw VersionNotFoundInStoreError and include available versions", async () => {
    const options: SearchToolOptions = { ...baseOptions, version: "nonexistent" };
    const error = new VersionNotFoundInStoreError("test-lib", "nonexistent", ["1.0.0"]);
    (mockDocService.findBestVersion as Mock).mockRejectedValue(error);

    const caughtError = (await searchTool
      .execute(options)
      .catch((e) => e)) as VersionNotFoundInStoreError;

    expect(caughtError).toBeInstanceOf(VersionNotFoundInStoreError);
    expect(caughtError.library).toBe("test-lib");
    expect(caughtError.version).toBe("nonexistent");
    expect(caughtError.availableVersions).toEqual(["1.0.0"]);
    expect(caughtError.message).toContain("Version nonexistent");
    expect(caughtError.message).toContain("test-lib");
  });

  it("should sanitize unexpected errors from findBestVersion", async () => {
    const options: SearchToolOptions = { ...baseOptions, version: "1.x" };
    const unexpectedError = new Error("Store connection failed");
    (mockDocService.findBestVersion as Mock).mockRejectedValue(unexpectedError);

    await expect(searchTool.execute(options)).rejects.toThrow(
      "Search failed during version resolution",
    );
  });

  it("should throw LibraryNotFoundInStoreError and include suggestions", async () => {
    const options: SearchToolOptions = { ...baseOptions };
    const similarLibraries = ["test-lib-correct", "another-test-lib"];
    const error = new LibraryNotFoundInStoreError("test-lib", similarLibraries);
    (mockDocService.validateLibraryExists as Mock).mockRejectedValue(error);

    const caughtError = (await searchTool
      .execute(options)
      .catch((e) => e)) as LibraryNotFoundInStoreError;

    expect(caughtError).toBeInstanceOf(LibraryNotFoundInStoreError);
    expect(caughtError.library).toBe("test-lib");
    expect(caughtError.similarLibraries).toEqual(similarLibraries);
    expect(caughtError.message).toContain("Library test-lib not found");
    expect(caughtError.message).toContain("Did you mean:");
  });

  it("should sanitize unexpected errors from validateLibraryExists", async () => {
    const options: SearchToolOptions = { ...baseOptions };
    const unexpectedError = new Error("Validation DB connection failed");
    (mockDocService.validateLibraryExists as Mock).mockRejectedValue(unexpectedError);

    await expect(searchTool.execute(options)).rejects.toThrow(
      "Search failed during library validation",
    );
  });

  it("should sanitize unexpected errors from searchStore", async () => {
    const options: SearchToolOptions = {
      ...baseOptions,
      version: "1.0.0",
      exactMatch: true,
    };
    const unexpectedError = new Error("Search index corrupted");
    (mockDocService.searchStore as Mock).mockRejectedValue(unexpectedError);

    await expect(searchTool.execute(options)).rejects.toThrow(
      "Search failed during document retrieval",
    );
  });

  it("does not expose the Search Query or raw failures in logs", async () => {
    const query = "private Search Query";
    const rawFailure = "raw store cause with https://private.example/internal";
    (mockDocService.searchStore as Mock).mockRejectedValue(new Error(rawFailure));

    const error = await searchTool
      .execute({
        library: "test-lib",
        version: "1.0.0",
        exactMatch: true,
        query,
      })
      .catch((caughtError: unknown) => caughtError);

    const logs = JSON.stringify({
      errors: vi.mocked(logger.error).mock.calls,
      info: vi.mocked(logger.info).mock.calls,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Search failed during document retrieval");
    expect(logs).not.toContain(query);
    expect(logs).not.toContain(rawFailure);
    expect(logs).not.toContain("https://private.example/internal");
  });

  it("sanitizes exact-match library validation failures", async () => {
    const rawFailure = "raw validation failure at http://private.internal/api";
    (mockDocService.validateLibraryExists as Mock).mockRejectedValue(
      new Error(rawFailure),
    );

    const error = await searchTool
      .execute({ ...baseOptions, exactMatch: true })
      .catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Search failed during library validation");
    expect((error as Error).message).not.toContain(rawFailure);
  });

  it("sanitizes exact-match version listing failures", async () => {
    const rawFailure = "raw version failure at http://private.internal/api";
    (mockDocService.validateLibraryExists as Mock).mockResolvedValue(undefined);
    (mockDocService.listLibraries as Mock).mockRejectedValue(new Error(rawFailure));

    const error = await searchTool
      .execute({ ...baseOptions, exactMatch: true })
      .catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Search failed during version resolution");
    expect((error as Error).message).not.toContain(rawFailure);
  });
});
