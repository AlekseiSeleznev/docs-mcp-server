import { readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { parseArtifactCatalog } from "../contracts";
import {
  type PublicArtifactMetadata,
  toPublicArtifactMetadata,
} from "./ArtifactReferenceMetadata";

const LIBRARY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/** Safe error returned when a process inventory cannot be listed. */
export class SourceArtifactListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceArtifactListError";
  }
}

/** Read-only Artifact Catalog location used for complete process inventories. */
export interface ListSourceArtifactsConfig {
  root: string;
}

/** Public metadata for one Source Artifact in a process inventory. */
export type ListedSourceArtifact = PublicArtifactMetadata;

/** Complete stable Source Artifact inventory for one exact process and version. */
export interface SourceArtifactInventory {
  library: string;
  libraryVersion: string;
  sourceRelease: string;
  process: {
    solutionId: string;
    processId: string;
    processName: string;
    lineOfBusiness: string[];
  };
  total: number;
  artifacts: ListedSourceArtifact[];
}

/** Lists Source Artifact metadata without reading source bytes. */
export class ListSourceArtifactsTool {
  constructor(private readonly config: ListSourceArtifactsConfig) {}

  /**
   * Lists the complete catalog-ordered inventory for one exact process.
   *
   * @param input - Exact library, semantic Library Version, and process ID.
   * @returns Complete public metadata, including honest unavailable statuses.
   */
  async execute(input: {
    library: string;
    version: string;
    processId: string;
  }): Promise<SourceArtifactInventory> {
    const { library, version, processId } = input;
    if (
      !LIBRARY_PATTERN.test(library) ||
      semver.valid(version) !== version ||
      processId.trim() === "" ||
      !path.isAbsolute(this.config.root)
    ) {
      throw new SourceArtifactListError("Invalid Source Artifact inventory request");
    }

    try {
      const root = path.resolve(this.config.root);
      const versionRoot = path.resolve(root, library, version);
      ensureContained(root, versionRoot);
      const catalog = parseArtifactCatalog(
        JSON.parse(
          await readFile(path.join(versionRoot, "artifact-catalog.json"), "utf8"),
        ) as unknown,
      );
      if (catalog.library !== library || catalog.libraryVersion !== version) {
        throw new SourceArtifactListError("Source Artifact library or version mismatch");
      }

      const processArtifacts = catalog.artifacts.filter(
        (artifact) => artifact.process.processId === processId,
      );
      const firstArtifact = processArtifacts[0];
      if (!firstArtifact) {
        throw new SourceArtifactListError("Source Artifact process not found");
      }
      if (
        processArtifacts.some(
          (artifact) =>
            artifact.process.solutionId !== firstArtifact.process.solutionId ||
            artifact.process.processName !== firstArtifact.process.processName,
        )
      ) {
        throw new SourceArtifactListError(
          "Source Artifact process identity is ambiguous",
        );
      }

      return {
        library,
        libraryVersion: version,
        sourceRelease: catalog.sourceRelease,
        process: firstArtifact.process,
        total: processArtifacts.length,
        artifacts: processArtifacts.map((artifact) =>
          toPublicArtifactMetadata(artifact, library, version),
        ),
      };
    } catch (error) {
      if (error instanceof SourceArtifactListError) {
        throw error;
      }
      throw new SourceArtifactListError("Source Artifact inventory could not be listed");
    }
  }
}

function ensureContained(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..") {
    return;
  }
  throw new SourceArtifactListError("Source Artifact inventory is outside its root");
}
