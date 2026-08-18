import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  artifactCatalogSchema,
  createArtifactId,
  parseArtifactCatalog,
} from "./ArtifactCatalog.js";

const fixtureUrl = (name: string): URL =>
  new URL(`../../test/fixtures/artifact-catalog/${name}`, import.meta.url);

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(fixtureUrl(name)), "utf8"));

describe("Artifact Catalog contract", () => {
  test("accepts a catalog containing every availability record", () => {
    const catalog = parseArtifactCatalog(readFixture("valid-catalog.json"));

    expect(catalog).toMatchObject({
      catalogVersion: "1",
      library: "sap_process_navigator",
      libraryVersion: "2025.1.0",
      sourceRelease: "2025-FPS1-RU",
    });
    expect(catalog.artifacts.map(({ availability }) => availability)).toEqual([
      "Downloaded",
      "Missing",
      "ExternalUnresolved",
    ]);
  });

  test.each([
    "malformed-hash.json",
    "invalid-status.json",
    "traversal-storage-key.json",
    "absolute-storage-key.json",
    "file-url-storage-key.json",
    "unavailable-blob.json",
  ])("rejects invalid catalog fixture %s", (fixture) => {
    expect(artifactCatalogSchema.safeParse(readFixture(fixture)).success).toBe(false);
  });

  test("derives a stable occurrence id from immutable occurrence identity", () => {
    const occurrence = {
      library: "sap_process_navigator",
      libraryVersion: "2025.1.0",
      solutionId: "EARL_SolS-055",
      processId: "2XU",
      canonicalRelativePath: "source/2XU/Test_script.docx",
      availability: "Downloaded" as const,
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(createArtifactId(occurrence)).toBe(
      "art_a9564419c27f1211ebce9495d25a271785001b35f1a22e14a7d1e82faeb0f75e",
    );
    expect(createArtifactId(occurrence)).toBe(createArtifactId(occurrence));
  });

  test("keeps identical bytes in different processes distinct", () => {
    const sharedOccurrenceIdentity = {
      library: "sap_process_navigator",
      libraryVersion: "2025.1.0",
      solutionId: "EARL_SolS-055",
      canonicalRelativePath: "source/2XU/Test_script.docx",
      availability: "Downloaded" as const,
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(createArtifactId({ ...sharedOccurrenceIdentity, processId: "2XU" })).not.toBe(
      createArtifactId({ ...sharedOccurrenceIdentity, processId: "3XU" }),
    );
  });

  test("keeps reused process ids in different solutions distinct", () => {
    const sharedOccurrenceIdentity = {
      library: "sap_process_navigator",
      libraryVersion: "2025.1.0",
      processId: "2XU",
      canonicalRelativePath: "source/2XU/Test_script.docx",
      availability: "Downloaded" as const,
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(
      createArtifactId({ ...sharedOccurrenceIdentity, solutionId: "EARL_SolS-055" }),
    ).not.toBe(createArtifactId({ ...sharedOccurrenceIdentity, solutionId: "OTHER" }));
  });

  test("rejects a supplied artifact id that does not match the occurrence", () => {
    const catalog = parseArtifactCatalog(readFixture("valid-catalog.json"));
    const modifiedCatalog = {
      ...catalog,
      artifacts: catalog.artifacts.map((artifact, index) =>
        index === 0
          ? {
              ...artifact,
              artifactId:
                "art_0000000000000000000000000000000000000000000000000000000000000000",
            }
          : artifact,
      ),
    };

    expect(artifactCatalogSchema.safeParse(modifiedCatalog).success).toBe(false);
  });

  test.each(["/source/2XU/file.pdf", "file:///source/2XU/file.pdf", "../file.pdf"])(
    "rejects unsafe occurrence path %s before deriving an id",
    (canonicalRelativePath) => {
      expect(() =>
        createArtifactId({
          library: "sap_process_navigator",
          libraryVersion: "2025.1.0",
          solutionId: "EARL_SolS-055",
          processId: "2XU",
          canonicalRelativePath,
          availability: "Downloaded",
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ).toThrow();
    },
  );
});
