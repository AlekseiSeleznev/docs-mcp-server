import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import {
  type ArtifactCatalog,
  type ArtifactReference,
  parseArtifactCatalog,
} from "../contracts/index.js";
import { createSourceArtifactResourceUri } from "./ArtifactReferenceMetadata.js";

const LIBRARY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{64}$/;

/** Safe error returned when a Source Artifact request fails closed. */
export class SourceArtifactReadError extends Error {
  constructor(
    message: string,
    readonly metadata?: SourceArtifactMetadata,
  ) {
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
  /** Opaque immutable Artifact Reference identity. */
  artifactId: string;
  /** Artifact availability after catalog validation. */
  availability: "Downloaded";
  /** Exact catalog library. */
  library: string;
  /** Exact catalog Library Version. */
  version: string;
  /** Source name retained from the producer manifest. */
  originalName: string;
  /** Safe verified filename for clients saving the source. */
  suggestedFilename: string;
  /** Verified effective media type. */
  mimeType: string;
  /** Catalog size verified against the opened file. */
  sizeBytes: number;
  /** Catalog SHA-256 verified against the exact bytes. */
  sha256: string;
  /** Canonical MCP resource URI for the same artifact. */
  resourceUri: string;
  /** Exact source bytes. */
  bytes: Buffer;
}

/** Safe metadata available without constructing a binary response. */
export type SourceArtifactMetadata = Omit<VerifiedSourceArtifact, "bytes">;

interface LocatedArtifact {
  artifact: ArtifactReference;
  catalog: ArtifactCatalog;
  versionRoot: string;
}

/**
 * Resolves opaque Source Artifact identities through trusted release catalogs.
 */
export class ReadSourceArtifactTool {
  constructor(private readonly config: ReadSourceArtifactConfig) {}

  /**
   * Reads one immutable Source Artifact and verifies its size and SHA-256.
   *
   * Supplying library and version performs a direct resource read. Supplying only
   * artifactId resolves the identity across the configured closed-world release root.
   *
   * @param input - Opaque Artifact Reference identity and optional exact release identity.
   * @returns Verified media type and exact source bytes.
   */
  async execute(input: {
    artifactId: string;
    library?: string;
    version?: string;
  }): Promise<VerifiedSourceArtifact> {
    const { artifactId, library, version } = input;
    this.validateRequest(artifactId, library, version);

    try {
      const root = await realpath(this.config.root);
      const located =
        library !== undefined && version !== undefined
          ? await this.locateInRelease(root, library, version, artifactId)
          : await this.locateByArtifactId(root, artifactId);
      const { artifact, catalog, versionRoot } = located;
      if (!artifact) {
        throw new SourceArtifactReadError("Source Artifact not found");
      }
      if (artifact.availability !== "Downloaded") {
        throw new SourceArtifactReadError("Source Artifact is not available for reading");
      }
      const metadata = createSourceArtifactMetadata(catalog, artifact);
      if (artifact.blob.sizeBytes > this.config.maxSizeBytes) {
        throw new SourceArtifactReadError(
          "Source Artifact exceeds the configured size limit",
          metadata,
        );
      }

      const requestedPath = path.resolve(versionRoot, artifact.blob.storageKey);
      ensureContained(versionRoot, requestedPath);
      const canonicalArtifactPath = await realpath(requestedPath);
      ensureContained(versionRoot, canonicalArtifactPath);

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
        return { ...metadata, bytes };
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

  private async locateInRelease(
    root: string,
    library: string,
    version: string,
    artifactId: string,
  ): Promise<LocatedArtifact> {
    const located = await this.locateOptionalInRelease(
      root,
      library,
      version,
      artifactId,
    );
    if (!located) {
      throw new SourceArtifactReadError("Source Artifact not found");
    }
    return located;
  }

  private async locateByArtifactId(
    root: string,
    artifactId: string,
  ): Promise<LocatedArtifact> {
    let match: LocatedArtifact | undefined;
    const libraryEntries = await readdir(root, { withFileTypes: true });
    for (const libraryEntry of libraryEntries) {
      if (!libraryEntry.isDirectory() || !LIBRARY_PATTERN.test(libraryEntry.name)) {
        continue;
      }
      const libraryRoot = await realpath(path.join(root, libraryEntry.name));
      ensureContained(root, libraryRoot);
      const versionEntries = await readdir(libraryRoot, { withFileTypes: true });
      for (const versionEntry of versionEntries) {
        if (
          !versionEntry.isDirectory() ||
          semver.valid(versionEntry.name) !== versionEntry.name
        ) {
          continue;
        }
        const candidate = await this.locateOptionalInRelease(
          root,
          libraryEntry.name,
          versionEntry.name,
          artifactId,
        );
        if (!candidate) {
          continue;
        }
        if (match) {
          throw new SourceArtifactReadError("Source Artifact identity is ambiguous");
        }
        match = candidate;
      }
    }
    if (!match) {
      throw new SourceArtifactReadError("Source Artifact not found");
    }
    return match;
  }

  private async locateOptionalInRelease(
    root: string,
    library: string,
    version: string,
    artifactId: string,
  ): Promise<LocatedArtifact | undefined> {
    const versionRoot = await realpath(path.resolve(root, library, version));
    ensureContained(root, versionRoot);
    const catalog = await readCatalog(versionRoot);
    if (catalog.library !== library || catalog.libraryVersion !== version) {
      throw new SourceArtifactReadError("Source Artifact library or version mismatch");
    }
    const artifact = catalog.artifacts.find((entry) => entry.artifactId === artifactId);
    return artifact ? { artifact, catalog, versionRoot } : undefined;
  }

  private validateRequest(artifactId: string, library?: string, version?: string): void {
    const hasReleaseIdentity = library !== undefined || version !== undefined;
    if (
      !ARTIFACT_ID_PATTERN.test(artifactId) ||
      !path.isAbsolute(this.config.root) ||
      !Number.isSafeInteger(this.config.maxSizeBytes) ||
      this.config.maxSizeBytes <= 0 ||
      (hasReleaseIdentity &&
        (library === undefined ||
          version === undefined ||
          !LIBRARY_PATTERN.test(library) ||
          semver.valid(version) !== version))
    ) {
      throw new SourceArtifactReadError("Invalid Source Artifact request");
    }
  }
}

async function readCatalog(versionRoot: string): Promise<ArtifactCatalog> {
  const catalogPath = await realpath(path.join(versionRoot, "artifact-catalog.json"));
  ensureContained(versionRoot, catalogPath);
  return parseArtifactCatalog(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
}

function createSourceArtifactMetadata(
  catalog: ArtifactCatalog,
  artifact: Extract<ArtifactReference, { availability: "Downloaded" }>,
): SourceArtifactMetadata {
  verifyOfficeSuggestedFilename(artifact.blob.effectiveMime, artifact.blob.suggestedName);
  return {
    artifactId: artifact.artifactId,
    availability: artifact.availability,
    library: catalog.library,
    version: catalog.libraryVersion,
    originalName: artifact.blob.originalName,
    suggestedFilename: artifact.blob.suggestedName,
    mimeType: artifact.blob.effectiveMime,
    sizeBytes: artifact.blob.sizeBytes,
    sha256: artifact.blob.sha256,
    resourceUri: createSourceArtifactResourceUri(
      catalog.library,
      catalog.libraryVersion,
      artifact.artifactId,
    ),
  };
}

function verifyOfficeSuggestedFilename(
  mimeType: string,
  suggestedFilename: string,
): void {
  const requiredExtension = new Map([
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ]).get(mimeType);
  if (requiredExtension && !suggestedFilename.toLowerCase().endsWith(requiredExtension)) {
    throw new SourceArtifactReadError("Source Artifact suggested filename is invalid");
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
