import { createHash } from "node:crypto";
import semver from "semver";
import { z } from "zod";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{64}$/;
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/;
const LIBRARY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-z]:/i;

const requiredTextSchema = z.string().trim().min(1);

const libraryNameSchema = requiredTextSchema.regex(LIBRARY_NAME_PATTERN, {
  error: "Library must be a lowercase slug",
});

const libraryVersionSchema = requiredTextSchema.refine(
  (value) => semver.valid(value) === value,
  "Library Version must be a canonical semantic version",
);

const sha256Schema = z.string().regex(SHA256_PATTERN, {
  error: "SHA-256 must contain exactly 64 lowercase hexadecimal characters",
});

const artifactIdSchema = z.string().regex(ARTIFACT_ID_PATTERN, {
  error: "Artifact ID must be an art_ prefix followed by a SHA-256 digest",
});

const mimeTypeSchema = z.string().regex(MIME_TYPE_PATTERN, {
  error: "MIME type must contain a valid type and subtype",
});

const safeRelativeKeySchema = requiredTextSchema.superRefine((value, context) => {
  const segments = value.split("/");
  const isUnsafe =
    value.startsWith("/") ||
    value.includes("\\") ||
    URL_SCHEME_PATTERN.test(value) ||
    WINDOWS_ABSOLUTE_PATTERN.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");

  if (isUnsafe) {
    context.addIssue({
      code: "custom",
      message: "Storage and representation keys must be canonical relative paths",
    });
  }
});

const safeFileNameSchema = requiredTextSchema.superRefine((value, context) => {
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    URL_SCHEME_PATTERN.test(value)
  ) {
    context.addIssue({
      code: "custom",
      message: "Artifact names must be file names without a path or URL",
    });
  }
});

const processIdentitySchema = z
  .object({
    solutionId: requiredTextSchema,
    processId: requiredTextSchema,
    processName: requiredTextSchema,
    lineOfBusiness: z.array(requiredTextSchema),
  })
  .strict();

const artifactReferenceBaseSchema = z
  .object({
    artifactId: artifactIdSchema,
    process: processIdentitySchema,
    canonicalRelativePath: safeRelativeKeySchema,
    type: requiredTextSchema,
    group: requiredTextSchema,
    name: requiredTextSchema,
  })
  .strict();

const downloadedArtifactReferenceSchema = artifactReferenceBaseSchema
  .extend({
    availability: z.literal("Downloaded"),
    blob: z
      .object({
        originalName: safeFileNameSchema,
        suggestedName: safeFileNameSchema,
        manifestMime: mimeTypeSchema,
        effectiveMime: mimeTypeSchema,
        sizeBytes: z.number().int().nonnegative(),
        sha256: sha256Schema,
        storageKey: safeRelativeKeySchema,
      })
      .strict(),
    indexedProvenance: z
      .object({
        representationKeys: z.array(safeRelativeKeySchema).min(1),
      })
      .strict(),
  })
  .strict();

const missingArtifactReferenceSchema = artifactReferenceBaseSchema
  .extend({
    availability: z.literal("Missing"),
  })
  .strict();

const externalUnresolvedArtifactReferenceSchema = artifactReferenceBaseSchema
  .extend({
    availability: z.literal("ExternalUnresolved"),
  })
  .strict();

const artifactReferenceSchema = z.discriminatedUnion("availability", [
  downloadedArtifactReferenceSchema,
  missingArtifactReferenceSchema,
  externalUnresolvedArtifactReferenceSchema,
]);

/** Current version of the generic Artifact Catalog wire contract. */
export const ARTIFACT_CATALOG_VERSION = "1" as const;

/**
 * Validates a complete Artifact Catalog and every contained Artifact Reference.
 */
export const artifactCatalogSchema = z
  .object({
    catalogVersion: z.literal(ARTIFACT_CATALOG_VERSION),
    library: libraryNameSchema,
    libraryVersion: libraryVersionSchema,
    sourceRelease: requiredTextSchema,
    artifacts: z.array(artifactReferenceSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const seenArtifactIds = new Set<string>();
    catalog.artifacts.forEach((artifact, index) => {
      if (seenArtifactIds.has(artifact.artifactId)) {
        context.addIssue({
          code: "custom",
          message: "Artifact IDs must be unique within a catalog",
          path: ["artifacts", index, "artifactId"],
        });
      }
      seenArtifactIds.add(artifact.artifactId);

      const expectedArtifactId = deriveArtifactId({
        library: catalog.library,
        libraryVersion: catalog.libraryVersion,
        solutionId: artifact.process.solutionId,
        processId: artifact.process.processId,
        canonicalRelativePath: artifact.canonicalRelativePath,
        ...(artifact.availability === "Downloaded"
          ? { availability: artifact.availability, sha256: artifact.blob.sha256 }
          : { availability: artifact.availability }),
      });
      if (artifact.artifactId !== expectedArtifactId) {
        context.addIssue({
          code: "custom",
          message: "Artifact ID must match its immutable occurrence identity",
          path: ["artifacts", index, "artifactId"],
        });
      }
    });
  });

/** A validated generic Artifact Catalog. */
export type ArtifactCatalog = z.infer<typeof artifactCatalogSchema>;

/** A validated Source Artifact reference from an Artifact Catalog. */
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

const artifactOccurrenceIdentityBaseSchema = z
  .object({
    library: libraryNameSchema,
    libraryVersion: libraryVersionSchema,
    solutionId: requiredTextSchema,
    processId: requiredTextSchema,
    canonicalRelativePath: safeRelativeKeySchema,
  })
  .strict();

type ArtifactOccurrenceIdentityBase = z.infer<
  typeof artifactOccurrenceIdentityBaseSchema
>;

/** Immutable identity inputs used to derive an occurrence-specific artifact ID. */
export type ArtifactOccurrenceIdentity = ArtifactOccurrenceIdentityBase &
  (
    | { availability: "Downloaded"; sha256: string }
    | { availability: "Missing" | "ExternalUnresolved" }
  );

const artifactOccurrenceIdentitySchema = z.discriminatedUnion("availability", [
  artifactOccurrenceIdentityBaseSchema
    .extend({
      availability: z.literal("Downloaded"),
      sha256: sha256Schema,
    })
    .strict(),
  artifactOccurrenceIdentityBaseSchema
    .extend({
      availability: z.enum(["Missing", "ExternalUnresolved"]),
    })
    .strict(),
]);

/**
 * Parses unknown input as a complete, strictly validated Artifact Catalog.
 *
 * @param input - Untrusted catalog input.
 * @returns The validated and strictly typed catalog.
 */
export function parseArtifactCatalog(input: unknown): ArtifactCatalog {
  return artifactCatalogSchema.parse(input);
}

/**
 * Derives a stable ID for one immutable Source Artifact occurrence.
 *
 * The process and canonical relative path are part of the digest, so identical
 * bytes used by different processes or occurrences retain distinct IDs.
 *
 * @param identity - Immutable library, process, path, and content identity.
 * @returns An opaque artifact ID prefixed with `art_`.
 */
export function createArtifactId(identity: ArtifactOccurrenceIdentity): string {
  const parsedIdentity = artifactOccurrenceIdentitySchema.parse(identity);
  return deriveArtifactId(parsedIdentity);
}

function deriveArtifactId(identity: ArtifactOccurrenceIdentity): string {
  const contentIdentity =
    identity.availability === "Downloaded"
      ? identity.sha256
      : `availability:${identity.availability}`;
  const digest = createHash("sha256")
    .update(
      [
        identity.library,
        identity.libraryVersion,
        identity.solutionId,
        identity.processId,
        identity.canonicalRelativePath,
        contentIdentity,
      ].join("\0"),
    )
    .digest("hex");

  return `art_${digest}`;
}
