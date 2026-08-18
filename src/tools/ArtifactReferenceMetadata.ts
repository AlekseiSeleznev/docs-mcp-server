import type { ArtifactReference } from "../contracts";

/** Public Source Artifact metadata that never exposes storage details or bytes. */
export type PublicArtifactMetadata =
  | {
      artifactId: string;
      type: string;
      group: string;
      name: string;
      availability: "Missing" | "ExternalUnresolved";
    }
  | {
      artifactId: string;
      type: string;
      group: string;
      name: string;
      availability: "Downloaded";
      suggestedFilename: string;
      mediaType: string;
      sizeBytes: number;
      resourceLink: string;
    };

/**
 * Projects a trusted catalog record into safe public metadata.
 *
 * @param artifact - Validated Artifact Catalog record.
 * @param library - Exact catalog library.
 * @param version - Exact catalog Library Version.
 * @returns Metadata without source bytes, filesystem paths, or storage keys.
 */
export function toPublicArtifactMetadata(
  artifact: ArtifactReference,
  library: string,
  version: string,
): PublicArtifactMetadata {
  const base = {
    artifactId: artifact.artifactId,
    type: artifact.type,
    group: artifact.group,
    name: artifact.name,
  };
  return artifact.availability === "Downloaded"
    ? {
        ...base,
        availability: artifact.availability,
        suggestedFilename: artifact.blob.suggestedName,
        mediaType: artifact.blob.effectiveMime,
        sizeBytes: artifact.blob.sizeBytes,
        resourceLink: `sap-artifact://${library}/${version}/${artifact.artifactId}`,
      }
    : { ...base, availability: artifact.availability };
}
