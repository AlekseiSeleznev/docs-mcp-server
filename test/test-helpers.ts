
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactId } from "../src/contracts";

/** Options for one temporary immutable Source Artifact release. */
export interface SourceArtifactReleaseFixtureOptions {
  availability?: "Downloaded" | "Missing" | "ExternalUnresolved";
  bytes?: Buffer;
}

/** Temporary release paths and identities used by Source Artifact tests. */
export interface SourceArtifactReleaseFixture {
  artifactId: string;
  artifactRoot: string;
  bytes: Buffer;
  catalogPath: string;
  library: string;
  storagePath: string;
  version: string;
  cleanup(): Promise<void>;
}

/**
 * Creates one catalog-backed Source Artifact release in a temporary directory.
 *
 * @param options - Availability and exact test bytes.
 * @returns Temporary release identities, paths, and cleanup callback.
 */
export async function createSourceArtifactReleaseFixture(
  options: SourceArtifactReleaseFixtureOptions = {},
): Promise<SourceArtifactReleaseFixture> {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "docs-mcp-artifact-"));
  const library = "sap_process_navigator";
  const version = "2025.1.0";
  const versionRoot = path.join(artifactRoot, library, version);
  const storageKey = "source/2XU/source.bpmn";
  const bytes = options.bytes ?? Buffer.from("<bpmn/>");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const availability = options.availability ?? "Downloaded";
  const artifactId = createArtifactId({
    library,
    libraryVersion: version,
    solutionId: "EARL_SolS-055",
    processId: "2XU",
    canonicalRelativePath: storageKey,
    ...(availability === "Downloaded" ? { availability, sha256 } : { availability }),
  });
  const artifactBase = {
    artifactId,
    process: {
      solutionId: "EARL_SolS-055",
      processId: "2XU",
      processName: "Procurement",
      lineOfBusiness: ["Sourcing and Procurement"],
    },
    canonicalRelativePath: storageKey,
    type: "BPMN",
    group: "Process",
    name: "Source model",
  };
  const artifact =
    availability === "Downloaded"
      ? {
          ...artifactBase,
          availability,
          blob: {
            originalName: "source.bpmn",
            suggestedName: "source.bpmn",
            manifestMime: "application/xml",
            effectiveMime: "application/xml",
            sizeBytes: bytes.length,
            sha256,
            storageKey,
          },
          indexedProvenance: { representationKeys: ["searchable/source.md"] },
        }
      : { ...artifactBase, availability };
  const catalogPath = path.join(versionRoot, "artifact-catalog.json");
  const storagePath = path.join(versionRoot, storageKey);
  await mkdir(path.dirname(storagePath), { recursive: true });
  if (availability === "Downloaded") {
    await writeFile(storagePath, bytes);
  }
  await writeFile(
    catalogPath,
    JSON.stringify({
      catalogVersion: "1",
      library,
      libraryVersion: version,
      sourceRelease: "2025-FPS1-RU",
      artifacts: [artifact],
    }),
  );

  return {
    artifactId,
    artifactRoot,
    bytes,
    catalogPath,
    library,
    storagePath,
    version,
    async cleanup() {
      await rm(artifactRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Returns the command and arguments to run the CLI.
 * Prefers the built 'dist/index.js' if available for faster execution.
 * Falls back to 'npx vite-node src/index.ts' for development.
 */
export function getCliCommand(): { cmd: string; args: string[] } {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const distEntry = path.join(projectRoot, "dist", "index.js");

  // Check if dist/index.js exists
  if (fs.existsSync(distEntry)) {
    return { cmd: "node", args: [distEntry] };
  }

  // Fallback to vite-node
  const srcEntry = path.join(projectRoot, "src", "index.ts");
  return { cmd: "npx", args: ["vite-node", srcEntry] };
}
