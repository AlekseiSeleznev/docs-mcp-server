
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

/** Isolated on-disk store and catalog-backed representation for MCP search E2E tests. */
export interface MatchedArtifactSearchFixture extends SourceArtifactReleaseFixture {
  env: NodeJS.ProcessEnv;
  missingArtifactId: string;
  relatedArtifactId: string;
  representationContent: string;
  representationUrl: string;
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
 * Creates one catalog-backed representation and isolated store for MCP E2E tests.
 *
 * @returns The release fixture plus the isolated server environment.
 */
export async function createMatchedArtifactSearchFixture(): Promise<MatchedArtifactSearchFixture> {
  const release = await createSourceArtifactReleaseFixture();
  const storePath = await mkdtemp(path.join(tmpdir(), "docs-mcp-search-store-"));
  const versionRoot = path.dirname(release.catalogPath);
  const representationPath = path.join(versionRoot, "searchable", "source.md");
  const representationContent = "Procurement artifact E2E sentinel";
  const catalog = JSON.parse(await readFile(release.catalogPath, "utf8")) as {
    artifacts: Array<Record<string, unknown>>;
  };
  const process = (catalog.artifacts[0] as { process: Record<string, unknown> }).process;
  const relatedPath = "source/2XU/test-script.docx";
  const relatedSha256 = createHash("sha256").update("related").digest("hex");
  const relatedArtifactId = createArtifactId({
    library: release.library,
    libraryVersion: release.version,
    solutionId: String(process.solutionId),
    processId: String(process.processId),
    canonicalRelativePath: relatedPath,
    availability: "Downloaded",
    sha256: relatedSha256,
  });
  const missingPath = "source/2XU/unavailable.pdf";
  const missingArtifactId = createArtifactId({
    library: release.library,
    libraryVersion: release.version,
    solutionId: String(process.solutionId),
    processId: String(process.processId),
    canonicalRelativePath: missingPath,
    availability: "Missing",
  });
  catalog.artifacts.push(
    {
      artifactId: relatedArtifactId,
      process,
      canonicalRelativePath: relatedPath,
      type: "Document",
      group: "Implementation",
      name: "Test script",
      availability: "Downloaded",
      blob: {
        originalName: "test-script.docx",
        suggestedName: "test-script.docx",
        manifestMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        effectiveMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 7,
        sha256: relatedSha256,
        storageKey: relatedPath,
      },
      indexedProvenance: { representationKeys: ["searchable/test-script.md"] },
    },
    {
      artifactId: missingArtifactId,
      process,
      canonicalRelativePath: missingPath,
      type: "PDF",
      group: "Implementation",
      name: "Unavailable guide",
      availability: "Missing",
    },
  );
  await writeFile(release.catalogPath, JSON.stringify(catalog));
  await mkdir(path.dirname(representationPath), { recursive: true });
  await writeFile(representationPath, representationContent);
  const env: NodeJS.ProcessEnv = {
    DOCS_MCP_STORE_PATH: storePath,
    DOCS_MCP_ARTIFACT_ROOT: release.artifactRoot,
    DOCS_MCP_SCRAPER_SECURITY_FILE_ACCESS_ALLOWED_ROOTS: JSON.stringify([
      release.artifactRoot,
    ]),
    DOCS_MCP_TELEMETRY: "false",
  };

  return {
    ...release,
    env,
    missingArtifactId,
    relatedArtifactId,
    representationContent,
    representationUrl: pathToFileURL(representationPath).href,
    async cleanup() {
      await release.cleanup();
      await rm(storePath, { recursive: true, force: true });
    },
  };
}

/**
 * Indexes a matched-artifact fixture through a connected MCP transport.
 *
 * @param client - Connected MCP client.
 * @param fixture - Catalog-backed representation fixture.
 */
export async function indexMatchedArtifactRepresentation(
  client: Client,
  fixture: MatchedArtifactSearchFixture,
): Promise<void> {
  const scrapeResult = await client.callTool({
    name: "scrape_docs",
    arguments: {
      url: fixture.representationUrl,
      library: fixture.library,
      version: fixture.version,
      maxPages: 1,
    },
  });
  const jobId = JSON.stringify(scrapeResult).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  )?.[0];
  if (!jobId) {
    throw new Error("MCP scrape did not return a job ID");
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const jobResult = await client.callTool({
      name: "get_job_info",
      arguments: { jobId },
    });
    const jobText = JSON.stringify(jobResult);
    if (jobText.includes("Status: completed")) {
      return;
    }
    if (jobText.includes("Status: failed")) {
      throw new Error("MCP scrape job failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("MCP scrape job did not complete in time");
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
