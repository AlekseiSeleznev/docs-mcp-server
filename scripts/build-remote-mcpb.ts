import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRemoteMcpbManifest,
  remoteMcpbArtifactName,
  REMOTE_MCPB_TARGETS,
  type RemoteMcpbTarget,
} from "../src/build/remoteMcpb";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArgument = process.argv[process.argv.indexOf("--target") + 1];
if (!targetArgument || !Object.hasOwn(REMOTE_MCPB_TARGETS, targetArgument)) {
  throw new Error(`Use --target with one of: ${Object.keys(REMOTE_MCPB_TARGETS).join(", ")}`);
}
const target = targetArgument as RemoteMcpbTarget;
const { platform, arch } = REMOTE_MCPB_TARGETS[target];
if (process.platform !== platform || process.arch !== arch) {
  throw new Error(`${target} must be built on ${platform}/${arch}`);
}

const bundlePath = path.join(projectRoot, "remote-mcpb-dist", "index.js");
if (!existsSync(bundlePath)) throw new Error("Run build:remote-mcpb:server first");

const outputDirectory = path.join(projectRoot, "artifacts");
mkdirSync(outputDirectory, { recursive: true });
const artifactPath = path.join(outputDirectory, remoteMcpbArtifactName(target));
const stageRoot = mkdtempSync(path.join(tmpdir(), "lib-docs-remote-mcpb-"));
try {
  const bundleDirectory = path.join(stageRoot, "remote-mcpb-dist");
  mkdirSync(bundleDirectory);
  cpSync(bundlePath, path.join(bundleDirectory, "index.js"));
  cpSync(path.join(projectRoot, "LICENSE"), path.join(stageRoot, "LICENSE"));
  writeFileSync(path.join(stageRoot, "manifest.json"), `${JSON.stringify(createRemoteMcpbManifest(target), null, 2)}\n`);
  writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);

  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const run = (args: string[]) =>
    execFileSync(executable, ["-y", "@anthropic-ai/mcpb@2.1.2", ...args], {
      cwd: projectRoot,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
  run(["validate", path.join(stageRoot, "manifest.json")]);
  run(["pack", stageRoot, artifactPath]);
  const manifest = JSON.parse(readFileSync(path.join(stageRoot, "manifest.json"), "utf8")) as { version: string };
  console.log(`Built ${path.basename(artifactPath)} (version ${manifest.version})`);
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
