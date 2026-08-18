import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { parseArtifactCatalog } from "../contracts/index.js";

const LIBRARY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{64}$/;

/** Safe error returned when a Source Artifact request fails closed. */
export class SourceArtifactReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceArtifactReadError";
  }
}

/** Runtime settings for immutable Source Artifact reads. */
export interface ReadSourceArtifactConfig {
  /** Absolute allowlisted root containing library/version release directories. */
  root: string;
  /** Maximum number of bytes returned by one read. */
  maxSizeBytes: number;
}

/** Exact Source Artifact content verified against its trusted catalog record. */
export interface VerifiedSourceArtifact {
  /** Verified effective media type. */
  mimeType: string;
  /** Exact source bytes. */
  bytes: Buffer;
}

/**
 * Resolves opaque Source Artifact identities through trusted release catalogs.
 */
export class ReadSourceArtifactTool {
  constructor(private readonly config: ReadSourceArtifactConfig) {}

  /**
   * Reads one immutable Source Artifact and verifies its size and SHA-256.
   *
   * @param input - Library, exact version, and opaque Artifact Reference identity.
   * @returns Verified media type and exact source bytes.
   */
  async execute(input: {
    library: string;
    version: string;
    artifactId: string;
  }): Promise<VerifiedSourceArtifact> {
    const { artifactId, library, version } = input;
    this.validateRequest(library, version, artifactId);

    try {
      const root = await realpath(this.config.root);
      const versionRoot = path.resolve(root, library, version);
      const canonicalVersionRoot = await realpath(versionRoot);
      ensureContained(root, canonicalVersionRoot);

      const catalogPath = path.join(canonicalVersionRoot, "artifact-catalog.json");
      const canonicalCatalogPath = await realpath(catalogPath);
      ensureContained(canonicalVersionRoot, canonicalCatalogPath);
      const catalog = parseArtifactCatalog(
        JSON.parse(await readFile(canonicalCatalogPath, "utf8")) as unknown,
      );
      if (catalog.library !== library || catalog.libraryVersion !== version) {
        throw new SourceArtifactReadError("Source Artifact library or version mismatch");
      }

      const artifact = catalog.artifacts.find((entry) => entry.artifactId === artifactId);
      if (!artifact) {
        throw new SourceArtifactReadError("Source Artifact not found");
      }
      if (artifact.availability !== "Downloaded") {
        throw new SourceArtifactReadError("Source Artifact is not available for reading");
      }
      if (artifact.blob.sizeBytes > this.config.maxSizeBytes) {
        throw new SourceArtifactReadError(
          "Source Artifact exceeds the configured size limit",
        );
      }

      const requestedPath = path.resolve(canonicalVersionRoot, artifact.blob.storageKey);
      ensureContained(canonicalVersionRoot, requestedPath);
      const canonicalArtifactPath = await realpath(requestedPath);
      ensureContained(canonicalVersionRoot, canonicalArtifactPath);

      const handle = await open(
        canonicalArtifactPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size !== artifact.blob.sizeBytes) {
          throw new SourceArtifactReadError("Source Artifact size verification failed");
        }
        const bytes = await handle.readFile();
        const actualSha256 = createHash("sha256").update(bytes).digest("hex");
        if (actualSha256 !== artifact.blob.sha256) {
          throw new SourceArtifactReadError(
            "Source Artifact integrity verification failed",
          );
        }
        return { mimeType: artifact.blob.effectiveMime, bytes };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof SourceArtifactReadError) {
        throw error;
      }
      throw new SourceArtifactReadError("Source Artifact could not be read");
    }
  }

  private validateRequest(library: string, version: string, artifactId: string): void {
    if (
      !LIBRARY_PATTERN.test(library) ||
      semver.valid(version) !== version ||
      !ARTIFACT_ID_PATTERN.test(artifactId) ||
      !path.isAbsolute(this.config.root) ||
      !Number.isSafeInteger(this.config.maxSizeBytes) ||
      this.config.maxSizeBytes <= 0
    ) {
      throw new SourceArtifactReadError("Invalid Source Artifact request");
    }
  }
}

function ensureContained(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new SourceArtifactReadError(
    "Source Artifact path is outside the allowlisted root",
  );
}
