import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const base = resolve(
  root,
  "backups/lib-skills/2026-08-30-113342+0300-before-unification/baseline",
);
const read = (path) => JSON.parse(readFileSync(resolve(base, path), "utf8")).results;
const old = read("old/lib-skills-old-2026-08-30-results.json");
const final = read("final-pass/skills-results.json");
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const summarize = (runs) => ({
  runs: runs.length,
  medianMs: median(runs.map(({ elapsedMs }) => elapsedMs)),
  medianMcpCalls: median(runs.map(({ tools }) => tools.length)),
  medianSearches: median(runs.map(({ checks }) => checks.searchCount)),
  exitsOk: runs.every(({ exitCode }) => exitCode === 0),
  leaks: runs.some(({ checks }) => checks.leakedInternalPath),
});
const byId = (runs, id) => runs.filter((run) => run.id === id);
const performanceIds = [
  "sap-dev-abap",
  "sap-cons-finance",
  "onec-dev-platform",
  "onec-cons-erp",
  "nifi",
  "postgresql",
  "sap-process-info",
  "project-docs-info",
];
const performance = performanceIds.map((id) => {
  let oldRuns = byId(old, id);
  let newRuns = byId(final, id);
  if (id === "project-docs-info") {
    oldRuns = read("cycle-3/ab-old/lib-skills-old-2026-08-30-results.json");
    newRuns = read("cycle-3/ab-new/skills-results.json");
  }
  if (id === "postgresql") {
    oldRuns = [
      ...read("final-ab/postgresql-old/lib-skills-old-2026-08-30-results.json"),
      ...read("final-ab/postgresql-old-2/lib-skills-old-2026-08-30-results.json"),
    ];
    newRuns = [
      ...read("final-ab/postgresql-new/skills-results.json"),
      ...read("final-ab/postgresql-new-2/skills-results.json"),
    ];
  }
  const before = summarize(oldRuns);
  const after = summarize(newRuns);
  return {
    id,
    skill: newRuns[0].skill,
    before,
    after,
    deltaMs: after.medianMs - before.medianMs,
    pass:
      before.exitsOk &&
      after.exitsOk &&
      !after.leaks &&
      after.medianMs <= before.medianMs &&
      after.medianMcpCalls <= before.medianMcpCalls,
  };
});
const artifactIds = ["sap-process-download", "project-docs-download"];
const artifacts = artifactIds.map((id) => {
  const before = byId(old, id)[0];
  const after = byId(final, id)[0];
  const oldGet = before.tools.find(({ tool }) => tool === "get_source_artifact");
  const newGet = after.tools.find(({ tool }) => tool === "get_source_artifact");
  return {
    id,
    sameArtifactId: oldGet?.arguments?.artifactId === newGet?.arguments?.artifactId,
    oldArtifactId: oldGet?.arguments?.artifactId,
    newArtifactId: newGet?.arguments?.artifactId,
  };
});
const ambiguous = read("cycle-3/ambiguous-final-2/skills-results.json")[0];
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  performance,
  artifacts,
  ambiguity: {
    mcpCalls: ambiguous.tools.length,
    hasFooter: ambiguous.checks.hasFooter,
    answer: ambiguous.answer,
  },
  pass:
    performance.every(({ pass }) => pass) &&
    artifacts.every(({ sameArtifactId }) => sameArtifactId) &&
    ambiguous.tools.length === 0 &&
    !ambiguous.checks.hasFooter,
};
const output = resolve(base, "comparison-summary.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) visit(path);
    else if (!path.endsWith("/SHA256SUMS")) files.push(path);
  }
};
visit(base);
const sums = files
  .sort()
  .map((path) => {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return `${digest}  ${path.slice(base.length + 1)}`;
  })
  .join("\n");
writeFileSync(resolve(base, "SHA256SUMS"), `${sums}\n`);
process.stdout.write(`${report.pass ? "PASS" : "FAIL"}: ${output}\n`);
if (!report.pass) process.exitCode = 1;
