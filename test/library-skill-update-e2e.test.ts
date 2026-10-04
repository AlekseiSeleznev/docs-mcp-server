import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const updater = resolve(import.meta.dirname, "../scripts/update-library-skill.py");
const name = "lib-test";
const roots: string[] = [];
const skill = (version: string) =>
  `---\nname: ${name}\nmetadata:\n  version: "${version}"\n---\n\n# Test\n`;
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function installed(version = "1.0.0") {
  const directory = mkdtempSync(join(tmpdir(), "library-skill-update-"));
  roots.push(directory);
  writeFileSync(join(directory, "SKILL.md"), skill(version));
  return directory;
}

function archive(version = "1.1.0", extra: Record<string, string> = {}) {
  const files = {
    "SKILL.md": skill(version),
    "agents/openai.yaml": "portable\n",
    ...extra,
  };
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import sys,json,io,zipfile,hashlib,base64
request=json.load(sys.stdin)
files=request['files']
sha=lambda value:hashlib.sha256(value.encode()).hexdigest()
record={'name':request['name'],'version':request['version'],'files':{key:sha(value) for key,value in files.items()}}
files['release.json']=json.dumps(record)
output=io.BytesIO()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as package:
 for key,value in files.items():package.writestr(request['name']+'/'+key,value)
print(json.dumps({'archive':base64.b64encode(output.getvalue()).decode(),'files':{key:sha(value) for key,value in files.items()}}))`,
    ],
    { input: JSON.stringify({ name, version, files }), encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  return { bytes: Buffer.from(output.archive, "base64"), files: output.files, version };
}

async function run(directory: string, url: string, inject = "") {
  const code = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('updater',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
${inject}
print(json.dumps(module.update_skill(pathlib.Path(sys.argv[2]),sys.argv[3])))`;
  const child = spawn("python3", ["-B", "-c", code, updater, directory, url]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  await new Promise<void>((accept, reject) => {
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? accept() : reject(new Error(stderr))));
  });
  return JSON.parse(stdout);
}

async function publication(
  candidate: ReturnType<typeof archive>,
  exercise: (
    url: string,
    requests: string[],
    entry: Record<string, unknown>,
  ) => Promise<void>,
  catalogOverride?: unknown,
) {
  const requests: string[] = [];
  const entry: Record<string, unknown> = {
    version: candidate.version,
    sha256: hash(candidate.bytes),
    files: candidate.files,
  };
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/ai-library/skill-versions.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          catalogOverride ?? { schemaVersion: 1, skills: { [name]: entry } },
        ),
      );
    } else if (request.url === `/ai-library/downloads/${name}.zip`) {
      response.end(candidate.bytes);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  const base = `http://127.0.0.1:${address.port}/ai-library/`;
  entry.url = `${base}downloads/${name}.zip`;
  try {
    await exercise(`${base}skill-versions.json`, requests, entry);
  } finally {
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
}

afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("library skill update over HTTP", () => {
  it("installs a newer verified release, preserves client settings, and requires rereading", async () => {
    const directory = installed();
    mkdirSync(join(directory, "agents"));
    writeFileSync(join(directory, "agents/openai.yaml"), "local client configuration\n");
    writeFileSync(join(directory, "notes.txt"), "local notes\n");
    await publication(
      archive("1.1.0", { "references/rules.md": "new rules\n" }),
      async (url, requests) => {
        expect(await run(directory, url)).toEqual({
          status: "updated",
          previousVersion: "1.0.0",
          version: "1.1.0",
          reread: "SKILL.md",
        });
        expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.1.0"));
        expect(readFileSync(join(directory, "references/rules.md"), "utf8")).toBe(
          "new rules\n",
        );
        expect(readFileSync(join(directory, "agents/openai.yaml"), "utf8")).toBe(
          "local client configuration\n",
        );
        expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("local notes\n");
        expect(await run(directory, url)).toEqual({
          status: "current",
          version: "1.1.0",
        });
        expect(requests.filter((path) => path.endsWith(".zip"))).toHaveLength(1);
      },
    );
  });

  it.each(["1.1.0", "2.0.0"])(
    "keeps installed %s without downloading an equal or older release",
    async (version) => {
      const directory = installed(version);
      await publication(archive(), async (url, requests) => {
        expect(await run(directory, url)).toEqual({
          status: version === "1.1.0" ? "current" : "local_newer",
          version,
        });
        expect(requests).toHaveLength(1);
        expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill(version));
      });
    },
  );

  it.each(["archive", "file", "url"])(
    "rejects a mismatched %s before installing",
    async (problem) => {
      const directory = installed();
      await publication(archive(), async (url, _requests, entry) => {
        if (problem === "archive") entry.sha256 = "0".repeat(64);
        if (problem === "file")
          entry.files = { ...archive().files, "SKILL.md": "0".repeat(64) };
        if (problem === "url") entry.url = "https://example.invalid/untrusted.zip";
        expect(await run(directory, url)).toMatchObject({
          status: "unavailable",
          reason: "invalid_release",
        });
        expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
      });
    },
  );

  it("rejects archive traversal without writing outside the skill", async () => {
    const directory = installed();
    await publication(archive("1.1.0", { "../outside.md": "unsafe" }), async (url) => {
      expect(await run(directory, url)).toMatchObject({
        status: "unavailable",
        reason: "invalid_release",
      });
      expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
    });
  });

  it("preserves local skill edits instead of overwriting them", async () => {
    const directory = installed();
    writeFileSync(
      join(directory, "release.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        files: { "SKILL.md": hash(skill("1.0.0")) },
      }),
    );
    writeFileSync(join(directory, "SKILL.md"), `${skill("1.0.0")}Local changes\n`);
    await publication(archive(), async (url) => {
      expect(await run(directory, url)).toMatchObject({
        status: "blocked",
        reason: "local_changes",
      });
      expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toContain(
        "Local changes",
      );
    });
  });

  it("preserves files reached through an installed symlink", async () => {
    const directory = installed();
    const external = installed();
    writeFileSync(join(external, "rules.md"), "local external rules\n");
    symlinkSync(external, join(directory, "references"), "dir");
    await publication(
      archive("1.1.0", { "references/rules.md": "new rules\n" }),
      async (url) => {
        expect(await run(directory, url)).toMatchObject({
          status: "unavailable",
          reason: "invalid_release",
        });
        expect(readFileSync(join(external, "rules.md"), "utf8")).toBe(
          "local external rules\n",
        );
        expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
      },
    );
  });

  it("rolls back replaced files after an installation failure", async () => {
    const directory = installed();
    writeFileSync(join(directory, "a.txt"), "old\n");
    const inject = `original=module.atomic_write
def fail_once(path,data,mode):
 if path.name=='b.txt':raise PermissionError('fixture')
 return original(path,data,mode)
module.atomic_write=fail_once`;
    await publication(
      archive("1.1.0", { "a.txt": "new\n", "b.txt": "new\n" }),
      async (url) => {
        expect(await run(directory, url, inject)).toMatchObject({
          status: "blocked",
          reason: "permissions",
        });
        expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("old\n");
        expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
      },
    );
  });

  it.each([
    { catalog: [] },
    { catalog: { schemaVersion: 1, skills: [] } },
    { catalog: { schemaVersion: 1, skills: { [name]: null } } },
  ])(
    "handles malformed catalogs without touching the installation: $catalog",
    async ({ catalog }) => {
      const directory = installed();
      await publication(
        archive(),
        async (url) => {
          expect(await run(directory, url)).toMatchObject({
            status: "unavailable",
            reason: "invalid_release",
          });
          expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
        },
        catalog,
      );
    },
  );

  it("keeps the installed skill usable when the site is unavailable", async () => {
    const directory = installed();
    await publication(archive(), async (url) => {
      expect(await run(directory, `${url}.missing`)).toMatchObject({
        status: "unavailable",
        reason: "network_or_install",
      });
      expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe(skill("1.0.0"));
    });
  });
});

describe("published library skill packages", () => {
  it("ships an independently verifiable standalone updater in every site package", () => {
    const code = `import importlib.util,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('updater',root/'scripts/update-library-skill.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
catalog=json.loads((root/'skills/md/skill-versions.json').read_bytes())
assert len(catalog['skills'])==10
for name,release in catalog['skills'].items():
 files=module.verified_files((root/'skills/md/downloads'/f'{name}.zip').read_bytes(),name,release)
 assert files['scripts/update-skill.py']==(root/'scripts/update-library-skill.py').read_bytes()
 assert files['references/skill-update.md']==(root/'skills/lib-skill-creator/references/skill-update.md').read_bytes()
 for path,data in files.items():assert data==(root/'skills'/name/path).read_bytes()
print('PASS')`;
    const result = spawnSync(
      "python3",
      ["-B", "-c", code, resolve(import.meta.dirname, "..")],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("PASS");
  });
});
