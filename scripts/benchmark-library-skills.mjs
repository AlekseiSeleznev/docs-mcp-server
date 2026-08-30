import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const skillsRoot = resolve(option("--skills-root", "skills"));
const casesPath = resolve(option("--cases", "test/fixtures/library-skills-comparison.json"));
const outputDir = resolve(option("--output-dir", "artifacts/library-skills-comparison"));
const workers = Number(option("--workers", "4"));
const model = option("--model", "gpt-5.6-sol");
const effort = option("--effort", "medium");
const performanceRepeats = Number(option("--performance-repeats", "3"));
const onlyCase = option("--case", "");
const workspace = resolve(option("--workspace", process.cwd()));
const cases = JSON.parse(readFileSync(casesPath, "utf8")).filter(
  ({ id }) => !onlyCase || id === onlyCase,
);

if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
  throw new Error("--workers must be an integer from 1 to 8");
}
if (!cases.length) throw new Error("no benchmark cases selected");

mkdirSync(outputDir, { recursive: true });

const tasks = cases.flatMap((testCase) =>
  Array.from(
    { length: testCase.performance ? performanceRepeats : 1 },
    (_, index) => ({ testCase, attempt: index + 1 }),
  ),
);

async function run({ testCase, attempt }) {
  const runRoot = mkdtempSync(join(tmpdir(), `lib-bench-${testCase.id}-${attempt}-`));
  const codexHome = join(runRoot, "codex");
  const skillsDir = join(codexHome, "skills");
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync("/home/as/.codex/auth.json", join(codexHome, "auth.json"));
  symlinkSync("/home/as/.codex/config.toml", join(codexHome, "config.toml"));
  symlinkSync("/home/as/.codex/plugins", join(codexHome, "plugins"));
  symlinkSync(resolve(skillsRoot, testCase.skill), join(skillsDir, testCase.skill));

  const answerPath = join(runRoot, "answer.md");
  const eventsPath = join(runRoot, "events.jsonl");
  const eventsFile = createWriteStream(eventsPath);
  const started = new Map();
  const tools = [];
  const commands = [];
  const startedAt = Date.now();
  const child = spawn(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-m",
      model,
      "-c",
      `model_reasoning_effort=\"${effort}\"`,
      "-C",
      workspace,
      "-o",
      answerPath,
      `$${testCase.skill} ${testCase.prompt}`,
    ],
    {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    eventsFile.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item;
    if (!item?.id) continue;
    if (event.type === "item.started") started.set(item.id, Date.now());
    if (event.type !== "item.completed") continue;
    const durationMs = Date.now() - (started.get(item.id) ?? Date.now());
    if (item.type === "mcp_tool_call") {
      tools.push({ server: item.server, tool: item.tool, arguments: item.arguments, durationMs });
    } else if (item.type === "command_execution") {
      commands.push({ command: item.command, durationMs, exitCode: item.exit_code });
    }
  }
  const exitCode = await new Promise((resolveExit) => child.on("close", resolveExit));
  eventsFile.end();
  const answer = exitCode === 0 ? readFileSync(answerPath, "utf8") : "";
  return {
    id: testCase.id,
    skill: testCase.skill,
    attempt,
    prompt: testCase.prompt,
    profile: testCase.profile,
    performance: Boolean(testCase.performance),
    exitCode,
    elapsedMs: Date.now() - startedAt,
    tools,
    commands,
    answer,
    checks: {
      usedExpectedTool: tools.some(({ tool }) => tool === (testCase.expectedTool ?? "search_docs")),
      searchCount: tools.filter(({ tool }) => tool === "search_docs").length,
      hasFooter: answer.includes("[Использованы библиотеки:"),
      leakedInternalPath: /file:\/\/|\/opt\/docs-mcp-server|REMOTE_DOCS_MCP|BEARER_TOKEN/u.test(answer),
    },
    stderrSummary: stderr
      .split("\n")
      .filter((line) => /ERROR|failed to initialize MCP|exit/u.test(line))
      .slice(0, 10),
  };
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < tasks.length) {
    const task = tasks[cursor++];
    const result = await run(task);
    results.push(result);
    process.stderr.write(
      `${result.id}#${result.attempt}: exit=${result.exitCode} elapsed=${result.elapsedMs}ms tools=${result.tools.map(({ tool }) => tool).join(",")}\n`,
    );
  }
}

await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, worker));
results.sort((left, right) => left.id.localeCompare(right.id) || left.attempt - right.attempt);
const report = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  source: { skillsRoot, casesPath, model, effort, performanceRepeats },
  results,
};
const output = join(outputDir, `${basename(skillsRoot)}-results.json`);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${output}\n`);

if (results.some(({ exitCode }) => exitCode !== 0)) process.exitCode = 1;
