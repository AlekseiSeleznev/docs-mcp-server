import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporary: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "library-authoring-"));
  temporary.push(directory);
  const author = join(directory, "installed-author");
  const target = join(directory, "lib-postgresql");
  cpSync(join(root, "skills/lib-skill-creator"), author, { recursive: true });
  cpSync(join(root, "skills/lib-postgresql"), target, { recursive: true });
  const run = () => {
    const result = spawnSync(
      "python3",
      ["-B", join(author, "scripts/validate_library_skill.py"), target],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    return { status: result.status, output: result.stdout, error: result.stderr };
  };
  return { target, run };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable library authoring validation", () => {
  it("validates an intact released skill from outside both installed directories", () => {
    expect(fixture().run().status).toBe(0);
  });

  it("rejects a missing bundled page guide", () => {
    const { target, run } = fixture();
    unlinkSync(join(target, "references/indexed-pages.md"));
    expect(run()).toMatchObject({ status: 1 });
    expect(run().output).toContain("indexed-pages.md");
  });

  it("rejects a linked reference outside the standalone package", () => {
    const { target, run } = fixture();
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf8")}\n[External](../outside.md)\n`);
    expect(run()).toMatchObject({ status: 1 });
    expect(run().output).toContain("missing or external bundled reference");
  });

  it("treats source-link examples as code rather than missing package references", () => {
    const { target, run } = fixture();
    unlinkSync(join(target, "release.json"));
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf8")}\nExample: \`[file](<absolute path>)\`\n\n\`\`\`markdown\n[example](missing-example.md)\n\`\`\`\n`);
    expect(run().status).toBe(0);
  });

  it("reports malformed reference URLs without a traceback", () => {
    const { target, run } = fixture();
    unlinkSync(join(target, "release.json"));
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf8")}\n[Invalid](https://[invalid)\n`);
    expect(run()).toMatchObject({ status: 1, error: "" });
    expect(run().output).toContain("FAIL: invalid reference URL");
  });

  it("detects changed release bytes before publication", () => {
    const { target, run } = fixture();
    writeFileSync(join(target, "scripts/update-skill.py"), "# changed updater\n");
    expect(run()).toMatchObject({ status: 1 });
    expect(run().output).toContain("release file changed: scripts/update-skill.py");
  });

  it("preserves client metadata as a supported local override", () => {
    const { target, run } = fixture();
    const file = join(target, "agents/openai.yaml");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n# local client setting\n`);
    expect(run().status).toBe(0);
  });

  it("requires version metadata when the skill declares public auto-update", () => {
    const { target, run } = fixture();
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace(/  version: "[^"\n]+"\n/, ""));
    expect(run()).toMatchObject({ status: 1 });
    expect(run().output).toContain("requires metadata.version");
  });

  it("accepts a new unpublished skill with textual startChunk continuation", () => {
    const { target, run } = fixture();
    unlinkSync(join(target, "release.json"));
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("name: lib-postgresql", "name: lib-audit-pg"));
    const guide = join(target, "references/indexed-pages.md");
    writeFileSync(guide, "Use list_pages and read_page after find_version. Continue with startChunk from the text response.\n");
    expect(run().status).toBe(0);
  });

  it("rejects a copied release record for a differently named skill", () => {
    const { target, run } = fixture();
    const skill = join(target, "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("name: lib-postgresql", "name: lib-audit-pg"));
    expect(run()).toMatchObject({ status: 1 });
    expect(run().output).toContain("release.json identity or inventory is invalid");
  });
});
