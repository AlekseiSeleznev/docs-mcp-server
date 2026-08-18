import { describe, expect, it } from "vitest";
import { createSourceArtifactReleaseFixture } from "../../test/test-helpers";
import { ReadSourceArtifactTool } from "./ReadSourceArtifactTool";

describe("ReadSourceArtifactTool", () => {
  it("returns exact bytes and catalog-verified MIME for an opaque artifact ID", async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x3c, 0x62, 0x70, 0x6d, 0x6e]);
    const fixture = await createSourceArtifactReleaseFixture({ bytes });

    try {
      const result = await new ReadSourceArtifactTool({
        root: fixture.artifactRoot,
        maxSizeBytes: 10 * 1024 * 1024,
      }).execute({
        library: fixture.library,
        version: fixture.version,
        artifactId: fixture.artifactId,
      });

      expect(result).toEqual({ mimeType: "application/xml", bytes });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a non-absolute allowlisted root", async () => {
    const tool = new ReadSourceArtifactTool({ root: "relative", maxSizeBytes: 1024 });

    await expect(
      tool.execute({
        library: "example_library",
        version: "1.2.3",
        artifactId: `art_${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("Invalid Source Artifact request");
  });
});
