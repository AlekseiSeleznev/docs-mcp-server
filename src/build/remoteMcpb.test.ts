import { describe, expect, it } from "vitest";
import {
  createRemoteMcpbManifest,
  REMOTE_MCPB_TARGETS,
  remoteMcpbArtifactName,
} from "./remoteMcpb";

describe("remote MCPB release contract", () => {
  it("packages a separate extension for each desktop platform", () => {
    expect(Object.keys(REMOTE_MCPB_TARGETS)).toEqual([
      "linux-x64",
      "windows-x64",
      "macos-x64",
      "macos-arm64",
    ]);
    for (const target of Object.keys(REMOTE_MCPB_TARGETS) as Array<
      keyof typeof REMOTE_MCPB_TARGETS
    >) {
      expect(remoteMcpbArtifactName(target)).toBe(`lib-docs-4.0.0-${target}.mcpb`);
      expect(createRemoteMcpbManifest(target).compatibility.platforms).toEqual([
        REMOTE_MCPB_TARGETS[target].platform,
      ]);
    }
  });

  it("requests a sensitive token without embedding credentials or a local store", () => {
    const manifest = createRemoteMcpbManifest("linux-x64");
    expect(manifest.name).toBe("lib-docs");
    expect(manifest.version).toBe("4.0.0");
    expect(manifest.server.mcp_config.env.LIB_DOCS_BEARER_TOKEN).toBe(
      `\${user_config.bearer_token}`,
    );
    expect(manifest.user_config.bearer_token).toMatchObject({
      required: true,
      sensitive: true,
    });
    expect(JSON.stringify(manifest)).not.toContain("DOCS_MCP_STORE_PATH");
  });
});
