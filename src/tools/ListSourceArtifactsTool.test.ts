import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactId } from "../contracts";
import { ListSourceArtifactsTool } from "./ListSourceArtifactsTool";

describe("ListSourceArtifactsTool", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
    );
  });

  it("returns the complete stable process inventory including unavailable records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "list-source-artifacts-"));
    cleanupPaths.push(root);
    const library = "sap_process_navigator";
    const version = "2025.1.0";
    const versionRoot = path.join(root, library, version);
    const process = {
      solutionId: "EARL_SolS-055",
      processId: "2XU",
      processName: "Procurement",
      lineOfBusiness: ["Sourcing and Procurement"],
    };
    const downloadedPath = "source/2XU/source.bpmn";
    const sha256 = createHash("sha256").update("source").digest("hex");
    const downloadedId = createArtifactId({
      library,
      libraryVersion: version,
      solutionId: process.solutionId,
      processId: process.processId,
      canonicalRelativePath: downloadedPath,
      availability: "Downloaded",
      sha256,
    });
    const missingPath = "source/2XU/missing.pdf";
    const missingId = createArtifactId({
      library,
      libraryVersion: version,
      solutionId: process.solutionId,
      processId: process.processId,
      canonicalRelativePath: missingPath,
      availability: "Missing",
    });
    const otherProcessPath = "source/3XU/source.bpmn";
    const otherProcessId = createArtifactId({
      library,
      libraryVersion: version,
      solutionId: process.solutionId,
      processId: "3XU",
      canonicalRelativePath: otherProcessPath,
      availability: "ExternalUnresolved",
    });
    await mkdir(versionRoot, { recursive: true });
    await writeFile(
      path.join(versionRoot, "artifact-catalog.json"),
      JSON.stringify({
        catalogVersion: "1",
        library,
        libraryVersion: version,
        sourceRelease: "2025-FPS1-RU",
        artifacts: [
          {
            artifactId: downloadedId,
            process,
            canonicalRelativePath: downloadedPath,
            type: "BPMN",
            group: "Process",
            name: "Source model",
            availability: "Downloaded",
            blob: {
              originalName: "source.bpmn",
              suggestedName: "2XU.bpmn",
              manifestMime: "application/xml",
              effectiveMime: "application/xml",
              sizeBytes: 6,
              sha256,
              storageKey: downloadedPath,
            },
            indexedProvenance: { representationKeys: ["searchable/2xu/source.md"] },
          },
          {
            artifactId: missingId,
            process,
            canonicalRelativePath: missingPath,
            type: "PDF",
            group: "Implementation",
            name: "Unavailable guide",
            availability: "Missing",
          },
          {
            artifactId: otherProcessId,
            process: { ...process, processId: "3XU", processName: "Other" },
            canonicalRelativePath: otherProcessPath,
            type: "BPMN",
            group: "Process",
            name: "Other model",
            availability: "ExternalUnresolved",
          },
        ],
      }),
    );

    const result = await new ListSourceArtifactsTool({ root }).execute({
      library,
      version,
      processId: "2XU",
    });

    expect(result).toEqual({
      library,
      libraryVersion: version,
      sourceRelease: "2025-FPS1-RU",
      process,
      total: 2,
      artifacts: [
        {
          artifactId: downloadedId,
          type: "BPMN",
          group: "Process",
          name: "Source model",
          availability: "Downloaded",
          suggestedFilename: "2XU.bpmn",
          mediaType: "application/xml",
          sizeBytes: 6,
          resourceLink: `sap-artifact://${library}/${version}/${downloadedId}`,
        },
        {
          artifactId: missingId,
          type: "PDF",
          group: "Implementation",
          name: "Unavailable guide",
          availability: "Missing",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("blob");
    expect(JSON.stringify(result)).not.toContain("storageKey");
    expect(JSON.stringify(result)).not.toContain("canonicalRelativePath");
  });
});
