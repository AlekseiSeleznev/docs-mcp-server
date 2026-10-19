/** Version of the local read-only Claude Desktop extension. */
export const MCPB_VERSION = "3.3.1";

/** Supported platform and CPU pair for a native MCPB artifact. */
export interface McpbTarget {
  label: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
}

/** Package metadata used to populate the MCPB manifest. */
export interface McpbPackageMetadata {
  name: string;
  version: string;
  description: string;
  author: string | { name: string };
}

/** Minimal MCPB manifest shape produced by this project. */
export interface McpbManifest {
  manifest_version: "0.3";
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string };
  repository: { type: "git"; url: string };
  documentation: string;
  support: string;
  license: "MIT";
  keywords: string[];
  server: {
    type: "node";
    entry_point: string;
    mcp_config: {
      command: "node";
      args: string[];
    };
  };
  tools: Array<{ name: string; description: string }>;
  tools_generated: false;
  compatibility: {
    platforms: Array<"darwin" | "win32">;
    runtimes: { node: ">=22" };
  };
}

/** Native targets published for Claude Desktop. */
export const MCPB_TARGETS = {
  "windows-x64": { label: "windows-x64", platform: "win32", arch: "x64" },
  "macos-x64": { label: "macos-x64", platform: "darwin", arch: "x64" },
  "macos-arm64": {
    label: "macos-arm64",
    platform: "darwin",
    arch: "arm64",
  },
} as const satisfies Record<string, McpbTarget>;

/** Creates the release filename for a platform-specific MCPB artifact. */
export function createMcpbArtifactName(version: string, target: McpbTarget): string {
  return `lib-docs-${version}-${target.label}.mcpb`;
}

/** Prevents native dependencies from being packaged for a different host target. */
export function assertNativeTarget(
  target: McpbTarget,
  actualPlatform: string = process.platform,
  actualArch: string = process.arch,
): void {
  if (target.platform !== actualPlatform || target.arch !== actualArch) {
    throw new Error(
      `${target.label} must be built on ${target.platform}/${target.arch}; current host is ${actualPlatform}/${actualArch}.`,
    );
  }
}

/** Creates the validated manifest contract shared by all platform builds. */
export function createMcpbManifest(
  packageMetadata: McpbPackageMetadata,
  target: McpbTarget,
): McpbManifest {
  const authorName =
    typeof packageMetadata.author === "string"
      ? packageMetadata.author
      : packageMetadata.author.name;

  return {
    manifest_version: "0.3",
    name: "lib-docs",
    display_name: "lib-docs",
    version: MCPB_VERSION,
    description:
      "Search and read a local Grounded Docs index without exposing modification tools.",
    author: { name: authorName },
    repository: {
      type: "git",
      url: "https://github.com/arabold/docs-mcp-server.git",
    },
    documentation: "https://github.com/arabold/docs-mcp-server#readme",
    support: "https://github.com/arabold/docs-mcp-server/issues",
    license: "MIT",
    keywords: ["documentation", "search", "read-only"],
    server: {
      type: "node",
      entry_point: "mcpb-dist/index.js",
      mcp_config: {
        command: "node",
        args: ["--enable-source-maps", `\${__dirname}/mcpb-dist/index.js`],
      },
    },
    tools: [
      {
        name: "search_docs",
        description: "Search indexed documentation for a library or package.",
      },
      {
        name: "list_libraries",
        description: "List all indexed documentation libraries.",
      },
      {
        name: "find_version",
        description: "Find the best matching indexed version for a library.",
      },
      {
        name: "list_pages",
        description: "List indexed pages with URL filtering and pagination.",
      },
      {
        name: "read_page",
        description: "Read an indexed page with whole-chunk continuation.",
      },
    ],
    tools_generated: false,
    compatibility: {
      platforms: [target.platform],
      runtimes: { node: ">=22" },
    },
  };
}

/**
 * Creates the isolated extension's runtime package from locked dependency versions.
 * @param packageMetadata Application metadata; the extension manifest keeps its own version.
 * @param lockfile Installed package versions from the application lockfile.
 * @returns The package installed inside each native extension archive.
 */
export function createMcpbRuntimePackage(
  packageMetadata: McpbPackageMetadata & Record<string, unknown>,
  lockfile: { packages?: Record<string, { version?: string }> },
): Record<string, unknown> {
  const dependencyVersion = (name: string): string => {
    const version = lockfile.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`Missing locked version for ${name}`);
    return version;
  };
  return {
    name: packageMetadata.name,
    version: packageMetadata.version,
    private: true,
    type: "module",
    license: packageMetadata.license,
    engines: packageMetadata.engines,
    dependencies: {
      "@langchain/aws": dependencyVersion("@langchain/aws"),
      "@langchain/core": dependencyVersion("@langchain/core"),
      "@langchain/google-genai": dependencyVersion("@langchain/google-genai"),
      "@langchain/google-vertexai": dependencyVersion("@langchain/google-vertexai"),
      "@langchain/openai": dependencyVersion("@langchain/openai"),
      "@modelcontextprotocol/sdk": dependencyVersion("@modelcontextprotocol/sdk"),
      "better-sqlite3": dependencyVersion("better-sqlite3"),
      "env-paths": dependencyVersion("env-paths"),
      "fuse.js": dependencyVersion("fuse.js"),
      mime: dependencyVersion("mime"),
      psl: dependencyVersion("psl"),
      semver: dependencyVersion("semver"),
      "sqlite-vec": dependencyVersion("sqlite-vec"),
      yaml: dependencyVersion("yaml"),
      zod: dependencyVersion("zod"),
    },
  };
}
