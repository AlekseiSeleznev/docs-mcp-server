/** Version of the hosted-library Claude Desktop extension. */
export const REMOTE_MCPB_VERSION = "4.0.0";

/** Supported native desktop targets. The bundled bridge has no native dependencies. */
export const REMOTE_MCPB_TARGETS = {
  "linux-x64": { platform: "linux", arch: "x64" },
  "windows-x64": { platform: "win32", arch: "x64" },
  "macos-x64": { platform: "darwin", arch: "x64" },
  "macos-arm64": { platform: "darwin", arch: "arm64" },
} as const;

export type RemoteMcpbTarget = keyof typeof REMOTE_MCPB_TARGETS;

/** Returns the artifact name of a remote-library desktop extension. */
export function remoteMcpbArtifactName(target: RemoteMcpbTarget): string {
  return `lib-docs-${REMOTE_MCPB_VERSION}-${target}.mcpb`;
}

/** Creates a manifest that obtains the token at installation, never from the archive. */
export function createRemoteMcpbManifest(target: RemoteMcpbTarget) {
  const { platform } = REMOTE_MCPB_TARGETS[target];
  return {
    manifest_version: "0.3",
    name: "lib-docs",
    display_name: "Plaut AI библиотека",
    version: REMOTE_MCPB_VERSION,
    description: "Search the hosted Plaut AI documentation library from Claude Desktop.",
    author: { name: "Plaut AI" },
    documentation: "https://aichat.msgplaut.com/ai-library",
    license: "MIT",
    keywords: ["documentation", "search", "remote", "library"],
    server: {
      type: "node",
      entry_point: "remote-mcpb-dist/index.js",
      mcp_config: {
        command: "node",
        args: [`\${__dirname}/remote-mcpb-dist/index.js`],
        env: { LIB_DOCS_BEARER_TOKEN: `\${user_config.bearer_token}` },
      },
    },
    user_config: {
      bearer_token: {
        type: "string",
        title: "lib-docs Bearer token",
        description: "Access token supplied by the Plaut AI library administrator.",
        sensitive: true,
        required: true,
      },
    },
    tools_generated: true,
    compatibility: {
      platforms: [platform],
      runtimes: { node: ">=22" },
    },
  };
}
