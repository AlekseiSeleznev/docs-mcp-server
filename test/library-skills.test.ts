import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const librarySkills = {
  "lib-nifi": "nifi",
  "lib-pm2-it": "pm2-it",
  "lib-postgresql": "postgresql",
  "lib-sap-process-navigator": "sap_process_navigator",
  "lib-sap-sf-odata": "sap-sf-odata",
} as const;

function skillFile(name: string, file = "SKILL.md") {
  return readFileSync(resolve(root, "skills", name, file), "utf8");
}

describe.each(Object.entries(librarySkills))("%s", (skill, library) => {
  const text = skillFile(skill);
  const agent = skillFile(skill, "agents/openai.yaml");

  it("keeps one fixed library and the matching final footer", () => {
    const libraries = [...text.matchAll(/library="([a-z0-9_-]+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(libraries)).toEqual(new Set([library]));
    expect(text).toContain(`[Использованы библиотеки: ${library}]`);
    expect(text.toLowerCase()).toContain("последней строкой без текста после неё");
  });

  it("uses the shared ambiguity and search budget contract", () => {
    expect(text).toContain("До ответа не вызывай инструменты");
    expect(text).toContain("начальный `search_docs` выполни с `limit=5`");
    expect(text).toContain("не более двух раз");
    expect(text).toContain("Абсолютный предел");
    expect(text).toContain("После третьего поиска остановись");
    expect(text).toContain("только `limit=5` или `limit=10`");
    expect(text).toContain("Никогда не вызывай");
  });

  it("uses the shared grounded answer format", () => {
    expect(text).toContain("## По документации");
    expect(text).toContain("`### 1.`, `### 2.`");
    expect(text).toContain("литерал `[Источник]` используй ровно один раз");
    expect(text).toContain("Никогда не повторяй `[Источник]` после `|`");
    expect(text).toContain("через ` | `");
    expect(text).toContain("каждый фрагмент по обе стороны разделителя");
    expect(text).toContain("Не ставь после `|` отдельный URL или раздел");
    expect(text).toContain("## Выводы и рекомендации");
    expect(text).toContain("не показывай `file://`");
    expect(text).toContain("Snapshot date");
    expect(text).toContain("undefined");
    expect(text).toContain("Даже при недоступности MCP");
    expect(text).toContain("помести состояние в `### 1.`");
    expect(text).toContain("без поясняющей фразы");
    expect(text).toContain("[Использованы библиотеки: нет]");
  });

  it("contains routing keywords but no concrete example questions", () => {
    expect(text).not.toContain("?");
    expect(text).not.toMatch(/пример(?:ы)? вопрос/iu);
    expect(text).not.toMatch(/пользователь спрашивает/iu);
  });

  it("declares the lib-docs MCP dependency", () => {
    expect(agent).toContain('value: "lib-docs"');
    expect(agent).toContain("allow_implicit_invocation: true");
  });
});

describe("lib-skill-creation", () => {
  const text = skillFile("lib-skill-creation");
  const agent = skillFile("lib-skill-creation", "agents/openai.yaml");
  const contract = skillFile(
    "lib-skill-creation",
    "references/library-skill-contract.md",
  );
  const validator = skillFile(
    "lib-skill-creation",
    "scripts/validate_library_skill.py",
  );

  it("requires initialization, static validation, and blind forward tests", () => {
    expect(text).toContain("skill-creator/scripts/init_skill.py");
    expect(text).toContain("quick_validate.py");
    expect(text).toContain("validate_library_skill.py");
    expect(text).toContain("blind forward-тесты");
    expect(text).toContain("свежих агентских контекстах");
  });

  it("forbids embedded questions and carries the full contract", () => {
    expect(text).toContain(
      "Не добавляй конкретные пользовательские вопросы, демонстрационные запросы",
    );
    expect(contract).toContain("Абсолютный максимум — три `search_docs`");
    expect(contract).toContain("Литерал `[Источник]` появляется ровно один раз");
    expect(contract).toContain("[Использованы библиотеки: TECHNICAL_NAME]");
    expect(validator).toContain("def validate(skill_dir: Path)");
  });

  it("can inspect the target documentation library", () => {
    expect(agent).toContain('value: "lib-docs"');
    expect(agent).toContain("allow_implicit_invocation: true");
  });
});

describe("lib-sap-sf-odata ambiguity gate", () => {
  const text = skillFile("lib-sap-sf-odata");

  it("does not infer SuccessFactors from skill activation alone", () => {
    expect(text).toContain("Не считай путь к этому `SKILL.md`");
    expect(text).toContain("выбор библиотеки не достиг 100% определённости");
    expect(text).toContain("Выведи только вопрос");
    expect(text).toContain("не делай предположение о SuccessFactors");
    expect(text).toContain("Это правило имеет приоритет над поиском");
  });
});

describe("lib-sap-process-navigator artifact workflow", () => {
  const text = skillFile("lib-sap-process-navigator");
  type EnglishCase = {
    id: string;
    type: string;
    query: string;
    expectedProcessId: string;
    expectedArtifactName: string;
    mustContain: string;
  };
  type SourceExpectation = { suggestedFilename: string; mediaType: string };
  type RussianCase = {
    id: string;
    englishCaseId: string;
    promptRu: string;
    initialQuery: string;
    refinements: string[];
    representationType: string;
    expectedProcessId: string;
    expectedArtifactName: string;
    mustContain: string;
    retrieveSource: boolean;
    expectedSource?: SourceExpectation;
  };
  type QueryObservation = {
    query: string;
    limit: number;
    rank: number;
    topProcessIds: string[];
  };
  type RetrievalObservation = SourceExpectation & {
    sizeBytes: number;
    catalogSha256: string;
    savedSha256: string;
    formatCheck: string;
    temporaryCopyRemoved: boolean;
  };
  type ResultCase = {
    id: string;
    queries: QueryObservation[];
    matchedArtifact: {
      artifactId: string;
      name: string;
      mediaType: string;
      availability: string;
    };
    relatedArtifacts: { returned: number; truncated: boolean };
    answerRu: string;
    retrieval: RetrievalObservation | null;
  };
  const englishSnapshot = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/sap-process-navigator-english-acceptance.json"),
      "utf8",
    ),
  ) as {
    provenance: {
      repository: string;
      commit: string;
      sourcePath: string;
      sourceSha256: string;
    };
    cases: EnglishCase[];
  };
  const matrix = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/sap-process-navigator-russian-acceptance.json"),
      "utf8",
    ),
  ) as RussianCase[];
  const observations = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/sap-process-navigator-russian-results.json"),
      "utf8",
    ),
  ) as {
    runtime: {
      library: string;
      version: string;
      toolSurface: string[];
      publication: {
        sourceRef: string;
        installedPath: string;
        files: Record<string, string>;
        canonicalEqualsInstalled: boolean;
        quickValidate: string;
        librarySkillValidate: string;
      };
    };
    cases: ResultCase[];
    unavailableEvidence: Array<{ availability: string; blobReturned: boolean }>;
    negativeEvidence: {
      rawBinaryOrBase64Recorded: boolean;
      privateUrlRecorded: boolean;
      serverPathRecorded: boolean;
    };
  };
  const traces = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/sap-process-navigator-russian-traces.json"),
      "utf8",
    ),
  ) as {
    executionBoundary: { codexSkillRuns: string; sdkProtocolChecks: string };
    scenarioTraces: Array<{
      id: string;
      events: Array<{
        sequence: number;
        tool: string;
        arguments: Record<string, string | number>;
        resultRef?: string;
      }>;
    }>;
    relatedEvidence: Array<{
      id: string;
      processId: string;
      artifactId: string;
      availability: string;
      retrieved: boolean;
    }>;
    supplementalBlindContext: { answerRu: string; toolCalls: unknown[] };
    sdkProtocolChecks: { countedAsAgentRuns: boolean };
  };

  it("pins the complete accepted English corpus to its source revision", () => {
    expect(englishSnapshot.provenance).toEqual({
      repository: "AlekseiSeleznev/sap-library-mcp",
      commit: "5b8ce99a668f98c1eefcbb099c8d4680e2a3bb46",
      sourcePath: "scripts/build-searchable-index.mjs",
      sourceSha256: "43863f302f34bf124ee8f2d4a6ebea1a2e465dee9c96a36e719938e7b920bdd6",
    });
    expect(englishSnapshot.cases).toHaveLength(15);
    expect(englishSnapshot.cases.every(({ mustContain }) => mustContain.length > 0)).toBe(
      true,
    );
  });

  it("maps every Russian scenario to one complete accepted English case", () => {
    const englishById = new Map(
      englishSnapshot.cases.map((acceptanceCase) => [acceptanceCase.id, acceptanceCase]),
    );
    expect(matrix.map(({ id }) => id)).toEqual(
      Array.from({ length: 15 }, (_, index) =>
        `RU-${String(index + 1).padStart(2, "0")}`,
      ),
    );
    for (const acceptanceCase of matrix) {
      const englishCase = englishById.get(acceptanceCase.englishCaseId);
      expect({
        query: acceptanceCase.initialQuery,
        type: acceptanceCase.representationType,
        expectedProcessId: acceptanceCase.expectedProcessId,
        expectedArtifactName: acceptanceCase.expectedArtifactName,
        mustContain: acceptanceCase.mustContain,
      }).toEqual(
        englishCase
          ? {
              query: englishCase.query,
              type: englishCase.type,
              expectedProcessId: englishCase.expectedProcessId,
              expectedArtifactName: englishCase.expectedArtifactName,
              mustContain: englishCase.mustContain,
            }
          : undefined,
      );
    }
  });

  it("keeps Russian prompts on bounded English search traces", () => {
    expect(matrix.every(({ promptRu }) => /[А-Яа-яЁё]/u.test(promptRu))).toBe(true);
    expect(matrix.every(({ initialQuery }) => !/[А-Яа-яЁё]/u.test(initialQuery))).toBe(
      true,
    );
    expect(matrix.every(({ refinements }) => refinements.length <= 2)).toBe(true);
    expect(
      observations.cases.every(
        ({ queries }) =>
          queries.length <= 3 && queries.every(({ limit }) => limit === 5 || limit === 10),
      ),
    ).toBe(true);
  });

  it("records a grounded top-five Russian verdict for all fifteen scenarios", () => {
    const matrixById = new Map(matrix.map((acceptanceCase) => [acceptanceCase.id, acceptanceCase]));
    expect(observations.cases).toHaveLength(15);
    expect(observations.cases.map(({ id }) => id)).toEqual(
      Array.from({ length: 15 }, (_, index) =>
        `RU-${String(index + 1).padStart(2, "0")}`,
      ),
    );
    for (const observation of observations.cases) {
      const acceptanceCase = matrixById.get(observation.id);
      const finalQuery = observation.queries.at(-1);
      expect(acceptanceCase).toBeDefined();
      expect(observation.queries.map(({ query }) => query)).toEqual([
        acceptanceCase?.initialQuery,
        ...(acceptanceCase?.refinements ?? []),
      ]);
      expect(finalQuery?.rank).toBeGreaterThanOrEqual(1);
      expect(finalQuery?.rank).toBeLessThanOrEqual(5);
      expect(finalQuery?.topProcessIds).toContain(acceptanceCase?.expectedProcessId);
      expect(observation.matchedArtifact.name).toBe(acceptanceCase?.expectedArtifactName);
      expect(observation.matchedArtifact.availability).toBe("Downloaded");
      expect(observation.answerRu).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it("keeps ten factual scenarios free of source retrieval", () => {
    const factualIds = matrix
      .filter(({ retrieveSource }) => !retrieveSource)
      .map(({ id }) => id);
    expect(factualIds).toHaveLength(10);
    expect(
      observations.cases
        .filter(({ id }) => factualIds.includes(id))
        .every(({ retrieval }) => retrieval === null),
    ).toBe(true);
  });

  it("records one saved and hash-verified source for every required file type", () => {
    const sourceCases = matrix.filter(({ retrieveSource }) => retrieveSource);
    const resultById = new Map(observations.cases.map((result) => [result.id, result]));
    expect(sourceCases.map(({ representationType }) => representationType).sort()).toEqual(
      ["bpmn", "description", "docx", "pdf", "xlsx"],
    );
    for (const acceptanceCase of sourceCases) {
      const retrieval = resultById.get(acceptanceCase.id)?.retrieval;
      expect(retrieval).toMatchObject(acceptanceCase.expectedSource ?? {});
      expect(retrieval?.sizeBytes).toBeGreaterThan(0);
      expect(retrieval?.savedSha256).toBe(retrieval?.catalogSha256);
      expect(retrieval?.temporaryCopyRemoved).toBe(true);
    }
  });

  it("records Matched and Related Artifact observations separately", () => {
    const matrixById = new Map(matrix.map((acceptanceCase) => [acceptanceCase.id, acceptanceCase]));
    const resultsById = new Map(observations.cases.map((result) => [result.id, result]));
    expect(traces.relatedEvidence).toHaveLength(15);
    for (const related of traces.relatedEvidence) {
      expect(related.processId).toBe(matrixById.get(related.id)?.expectedProcessId);
      expect(related.artifactId).not.toBe(resultsById.get(related.id)?.matchedArtifact.artifactId);
      expect(["Downloaded", "Missing", "ExternalUnresolved"]).toContain(
        related.availability,
      );
      expect(related.retrieved).toBe(false);
    }
  });

  it("records ordered real Codex calls with version-first bounded searches", () => {
    expect(traces.scenarioTraces).toHaveLength(15);
    for (const trace of traces.scenarioTraces) {
      expect(trace.events.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: trace.events.length }, (_, index) => index + 1),
      );
      expect(trace.events[0]).toMatchObject({
        tool: "find_version",
        arguments: { library: "sap_process_navigator", targetVersion: "2025.x" },
      });
      expect(
        trace.events
          .filter(({ tool }) => tool === "search_docs")
          .every(
            ({ arguments: toolArguments }) =>
              toolArguments.library === "sap_process_navigator" &&
              toolArguments.version === "2025.1.0" &&
              (toolArguments.limit === 5 || toolArguments.limit === 10),
          ),
      ).toBe(true);
    }
    expect(traces.executionBoundary.codexSkillRuns).toContain("Real Codex");
    expect(traces.sdkProtocolChecks.countedAsAgentRuns).toBe(false);
  });

  it("records a fresh ambiguity clarification with zero MCP calls", () => {
    expect(traces.supplementalBlindContext.answerRu).toBe(
      "Вы ищете BPMN именно в SAP Process Navigator?",
    );
    expect(traces.supplementalBlindContext.toolCalls).toEqual([]);
  });

  it("records honest unavailable statuses without blobs", () => {
    expect(
      new Set(observations.unavailableEvidence.map(({ availability }) => availability)),
    ).toEqual(new Set(["Missing", "ExternalUnresolved"]));
    expect(
      observations.unavailableEvidence.every(({ blobReturned }) => !blobReturned),
    ).toBe(true);
  });

  it("records the exact closed read-only MCP surface", () => {
    expect(observations.runtime).toMatchObject({
      library: "sap_process_navigator",
      version: "2025.1.0",
      toolSurface: [
        "find_version",
        "get_source_artifact",
        "list_libraries",
        "list_source_artifacts",
        "search_docs",
      ],
    });
  });

  it("records no sensitive payloads in sanitized evidence", () => {
    expect(observations.negativeEvidence).toMatchObject({
      rawBinaryOrBase64Recorded: false,
      privateUrlRecorded: false,
      serverPathRecorded: false,
    });
  });

  it("records the installed skill as the validated canonical release", () => {
    expect(observations.runtime.publication).toEqual({
      sourceRef: "3d8bb31967abe6ca297f7bd700d09e018afb697d",
      canonicalSkillCommit: "4bc78a3d22a99bde1a4f963ec7f6effeb879e278",
      installedPath: "~/.codex/skills/lib-sap-process-navigator",
      files: {
        "SKILL.md": "0c7d89207e067349311a4f44eb1d0594a3bf8d49a9ace34101bcff862c05b9ed",
        "agents/openai.yaml": "82b7bf2a706b0ec3fcd84b97d159f2c51e855a334a2cf65b67180be77d67f165",
      },
      canonicalEqualsInstalled: true,
      quickValidate: "PASS",
      librarySkillValidate: "PASS",
    });
  });

  it("grounds Russian questions through bounded English SAP searches", () => {
    expect(text).toContain('targetVersion="2025.x"');
    expect(text).toContain("русск");
    expect(text).toContain("английск");
    expect(text).toContain("точные английские термины SAP");
    expect(text.toLowerCase()).toContain("не добавляй перевод");
  });

  it("distinguishes matched and related artifacts including unavailable statuses", () => {
    expect(text).toContain("Matched Artifacts");
    expect(text).toContain("Related Artifacts");
    expect(text).toContain("Missing");
    expect(text).toContain("ExternalUnresolved");
  });

  it("retrieves source bytes only through an opaque artifactId", () => {
    expect(text).toContain("list_source_artifacts");
    expect(text).toContain("get_source_artifact");
    expect(text).toContain("artifactId");
    expect(text).toContain("Не принимай от пользователя путь сервера");
    expect(text).toContain(
      "Получай байты только через `get_source_artifact`",
    );
    expect(text).toContain(
      "`[Источник] {Официальная публикация}; {Process ID, Process Name или раздел}; <{публичный URL}>`",
    );
    expect(text).toContain(
      "явном контексте процессов SAP",
    );
  });

  it("groups a concise final artifact list by user-facing type", () => {
    expect(text).toContain("## Артефакты");
    expect(text).toContain("Диаграммы процессов");
    expect(text).toContain("Описания процессов");
    expect(text).toContain("Акселераторы");
    expect(text).toContain("Оставь названия групп обычным текстом");
    expect(text).toContain("для `Downloaded` только `suggestedFilename`");
    expect(text).toContain("для недоступной записи — её `name`");
    expect(text).toContain("Не выводи пустую группу");
    expect(text).toContain("не показывай `artifactId`");
    expect(text).toContain(
      "`list_source_artifacts` один раз для каждого process ID",
    );
    expect(text).toContain("массива `structuredContent.artifacts`");
    expect(text).toContain("инвентарём выбранного процесса");
  });

  it("uses a deterministic destination policy for requested downloads", () => {
    expect(text).toContain("`artifacts/sap-process-navigator/<Process ID>/`");
    expect(text).toContain("Если проектная папка не найдена");
    expect(text).toContain("предложи рабочий стол как вариант по умолчанию");
    expect(text).toContain("разреши относительный путь от текущей рабочей папки");
    expect(text).toContain("`.git`, `package.json`, `pyproject.toml`");
    expect(text).toContain("Сначала определи папку назначения");
    expect(text).toContain("остановись до ответа");
    expect(text).toContain("Bundled writer сам");
    expect(text).toContain("сохраняет через `create-new`");
    expect(text).toContain("без временных файлов и удаления");
    expect(text).toContain("**Скачано**");
    expect(text).toContain("по одной строке `имя файла → полный путь`");
  });

  it("keeps the download sequence ordered and multiple processes identifiable", () => {
    const destination = text.indexOf("Сначала определи папку назначения");
    const retrieval = text.indexOf("Получи выбранные исходники только через");
    const persistence = text.indexOf("После завершения всех retrieval-вызовов");
    expect(destination).toBeGreaterThan(-1);
    expect(destination).toBeLessThan(retrieval);
    expect(retrieval).toBeLessThan(persistence);
    expect(text).toContain("`<Process ID> — <Process Name>`");
  });

  it("downloads every selected artifact and keeps a follow-up response concise", () => {
    expect(text).toContain("выбери все доступные записи");
    expect(text).toContain("Для каждого результата передай writer");
    expect(text).toContain("параллельно одним batch");
    expect(text).toContain("независимо от того, первый он или последующий");
    expect(text).toContain("не выводи разделы с документацией");
    expect(text).toContain("по одной строке `имя файла → полный путь`");
  });

  it("uses a ready interactive writer without narrating recoverable retries", () => {
    expect(text).toContain("В Codex сразу используй интерактивный режим");
    expect(text).toContain("дождись активной сессии");
    expect(text).toContain('JSON `{"ready":true}`');
    expect(text).toContain("Сохраняю {количество} файлов в {папка}");
    expect(text).toContain("Не сообщай о восстановимой внутренней ошибке");
  });

  it("renders every downloaded file as a clickable Codex local link", () => {
    expect(text).toContain("`- [имя файла](<абсолютный путь>)`");
    expect(text).toContain("оберни target в `<...>`");
    expect(text).toContain("не экранируй круглые скобки");
    expect(text).toContain("одну ссылку на каждый сохранённый файл");
  });

  it("uses one bundled fast-path writer after parallel artifact retrieval", () => {
    expect(text).toContain("`scripts/save-source-artifacts.mjs`");
    expect(text).toContain("параллельно одним batch");
    expect(text).toContain("После завершения всех retrieval-вызовов");
    expect(text).toContain("запусти writer ровно один раз");
    expect(text).toContain("Не генерируй inline Python");
    expect(text).toContain("не запускай диагностические sleep/probe-команды");
  });

  it("saves large JSONL payloads and resolves reuse and collisions", () => {
    const writer = resolve(
      root,
      "skills/lib-sap-process-navigator/scripts/save-source-artifacts.mjs",
    );
    const destination = mkdtempSync(join(tmpdir(), "sap-artifact-writer-"));
    try {
      const first = Buffer.from("A".repeat(16_384));
      const second = Buffer.from("B".repeat(16_384));
      const record = (data: Buffer) => ({
        suggestedFilename: "large payload.txt",
        blob: data.toString("base64"),
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        mimeType: "text/plain",
      });
      const input = [record(first), record(first), record(second)]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n";

      const output = execFileSync(
        process.execPath,
        [writer, "--destination", destination, "--count", "3"],
        { encoding: "utf8", input },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(output).toEqual([
        { ready: true, count: 3 },
        {
          name: "large payload.txt",
          path: join(destination, "large payload.txt"),
          status: "saved",
        },
        {
          name: "large payload.txt",
          path: join(destination, "large payload.txt"),
          status: "reused",
        },
        {
          name: "large payload.txt",
          path: join(destination, "large payload (1).txt"),
          status: "saved",
        },
      ]);
      expect(readFileSync(join(destination, "large payload.txt"))).toEqual(first);
      expect(readFileSync(join(destination, "large payload (1).txt"))).toEqual(second);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects an invalid payload without creating the requested file", () => {
    const writer = resolve(
      root,
      "skills/lib-sap-process-navigator/scripts/save-source-artifacts.mjs",
    );
    const destination = mkdtempSync(join(tmpdir(), "sap-artifact-writer-invalid-"));
    try {
      const input = `${JSON.stringify({
        suggestedFilename: "invalid.txt",
        blob: Buffer.from("payload").toString("base64"),
        sizeBytes: 7,
        sha256: "0".repeat(64),
        mimeType: "text/plain",
      })}\n`;
      const result = spawnSync(
        process.execPath,
        [writer, "--destination", destination, "--count", "1"],
        { encoding: "utf8", input },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("payload integrity check failed");
      expect(result.stderr).not.toContain(input);
      expect(existsSync(join(destination, "invalid.txt"))).toBe(false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("saves PPTX, legacy Word, and Microsoft Project payloads", () => {
    const writer = resolve(
      root,
      "skills/lib-sap-process-navigator/scripts/save-source-artifacts.mjs",
    );
    const destination = mkdtempSync(join(tmpdir(), "sap-artifact-writer-office-"));
    const pptx = Buffer.concat([
      Buffer.from("PK"),
      Buffer.from("ppt/slides/slide1.xml"),
    ]);
    const doc = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("WordDocument"),
    ]);
    const mpp = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("Microsoft Project"),
    ]);
    const record = (
      name: string,
      data: Buffer,
      mimeType: string,
    ) => ({
      suggestedFilename: name,
      blob: data.toString("base64"),
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      mimeType,
    });
    try {
      const input = [
        record(
          "deck.pptx",
          pptx,
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        record("legacy.doc", doc, "application/msword"),
        record("plan.mpp", mpp, "application/vnd.ms-project"),
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n";
      const output = execFileSync(
        process.execPath,
        [writer, "--destination", destination, "--count", "3"],
        { encoding: "utf8", input },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(output).toEqual([
        { ready: true, count: 3 },
        { name: "deck.pptx", path: join(destination, "deck.pptx"), status: "saved" },
        { name: "legacy.doc", path: join(destination, "legacy.doc"), status: "saved" },
        { name: "plan.mpp", path: join(destination, "plan.mpp"), status: "saved" },
      ]);
      expect(readFileSync(join(destination, "deck.pptx"))).toEqual(pptx);
      expect(readFileSync(join(destination, "legacy.doc"))).toEqual(doc);
      expect(readFileSync(join(destination, "plan.mpp"))).toEqual(mpp);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects PPTX, DOC, and MPP payloads that do not match their media type", () => {
    const writer = resolve(
      root,
      "skills/lib-sap-process-navigator/scripts/save-source-artifacts.mjs",
    );
    const destination = mkdtempSync(join(tmpdir(), "sap-artifact-writer-bad-office-"));
    const cases = [
      {
        name: "fake.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        data: Buffer.from("PK word/document.xml"),
        error: "invalid PPTX",
      },
      {
        name: "fake.doc",
        mimeType: "application/msword",
        data: Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.from("Microsoft Project"),
        ]),
        error: "invalid DOC",
      },
      {
        name: "fake.mpp",
        mimeType: "application/vnd.ms-project",
        data: Buffer.from("not ole"),
        error: "invalid MPP",
      },
    ];
    try {
      for (const testCase of cases) {
        const input = `${JSON.stringify({
          suggestedFilename: testCase.name,
          blob: testCase.data.toString("base64"),
          sizeBytes: testCase.data.length,
          sha256: createHash("sha256").update(testCase.data).digest("hex"),
          mimeType: testCase.mimeType,
        })}\n`;
        const result = spawnSync(
          process.execPath,
          [writer, "--destination", destination, "--count", "1"],
          { encoding: "utf8", input },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(testCase.error);
        expect(existsSync(join(destination, testCase.name))).toBe(false);
      }
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe("lib-project-docs combining skill", () => {
  const text = skillFile("lib-project-docs");
  const agent = skillFile("lib-project-docs", "agents/openai.yaml");
  const map = skillFile("lib-project-docs", "references/library-map.md");
  const skillDir = resolve(root, "skills/lib-project-docs");
  const requiredLibraries = [
    ...new Set(map.match(/project-docs-(?:luve|mane|polis)-\d{2}-[a-z-]+/g) ?? []),
  ];
  type ProjectCase = {
    id: string;
    promptRu: string;
    initialQuery: string;
    refinements: string[];
    libraries: string[];
    representationType: string;
    expectedProcessId: string;
    expectedArtifactName: string;
    mustContain: string;
    retrieveSource: boolean;
    expectedSource?: { suggestedFilename: string; mediaType: string };
  };
  type QueryObservation = {
    library: string;
    query: string;
    limit: number;
    rank: number;
    topProcessIds: string[];
  };
  type ResultCase = {
    id: string;
    queries: QueryObservation[];
    matchedArtifact: {
      artifactId: string;
      name: string;
      mediaType: string;
      availability: string;
    };
    relatedArtifacts: { returned: number; truncated: boolean };
    answerRu: string;
    retrieval: {
      suggestedFilename: string;
      mediaType: string;
      sizeBytes: number;
      catalogSha256: string;
      savedSha256: string;
      formatCheck: string;
      temporaryCopyRemoved: boolean;
    } | null;
  };
  const matrix = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/project-docs-russian-acceptance.json"),
      "utf8",
    ),
  ) as ProjectCase[];
  const observations = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/project-docs-russian-results.json"),
      "utf8",
    ),
  ) as {
    runtime: {
      family: string;
      version: string;
      sourceRelease: string;
      toolSurface: string[];
      publication: {
        installedPath: string;
        canonicalEqualsInstalled: boolean;
        combiningValidate: string;
        oneLibraryValidate: string;
      };
    };
    cases: ResultCase[];
    unavailableEvidence: Array<{ availability: string; blobReturned: boolean }>;
    negativeEvidence: {
      rawBinaryOrBase64Recorded: boolean;
      privateUrlRecorded: boolean;
      serverPathRecorded: boolean;
    };
  };
  const traces = JSON.parse(
    readFileSync(
      resolve(root, "test/fixtures/project-docs-russian-traces.json"),
      "utf8",
    ),
  ) as {
    scenarioTraces: Array<{
      id: string;
      events: Array<{
        sequence: number;
        tool: string;
        arguments: Record<string, string | number>;
      }>;
    }>;
    relatedEvidence: Array<{
      id: string;
      processId: string;
      artifactId: string;
      availability: string;
      retrieved: boolean;
    }>;
    supplementalBlindContext: { answerRu: string; toolCalls: unknown[] };
    sdkProtocolChecks: { countedAsAgentRuns: boolean };
  };

  it("is excluded from the one-library skill set", () => {
    expect(Object.keys(librarySkills)).not.toContain("lib-project-docs");
  });

  it("uses deterministic routing and search budgets", () => {
    expect(text).toContain("остановись без вызова инструментов и footer");
    expect(text).toContain("начальный `search_docs` выполни с `limit=5`");
    expect(text).toContain("остаток бюджета `6 - |L|`");
    expect(text).toContain("не больше трёх поисков");
    expect(text).toContain("только `limit=5` или `limit=10`");
    expect(text).toContain("больше трёх библиотек");
    expect(text).toContain("Изоляция клиентов");
  });

  it("uses the shared grounded answer format", () => {
    expect(text).toContain("## По документации");
    expect(text).toContain("`### 1.`, `### 2.`");
    expect(text).toContain("литерал `[Источник]` используй ровно один раз");
    expect(text).toContain("Никогда не повторяй `[Источник]` после `|`");
    expect(text).toContain("через ` | `");
    expect(text).toContain("каждый фрагмент по обе стороны разделителя");
    expect(text).toContain("Не ставь после `|` отдельный URL или раздел");
    expect(text).toContain("## Выводы и рекомендации");
    expect(text).toContain("не показывай `file://`");
    expect(text).toContain("Snapshot date");
    expect(text).toContain("undefined");
    expect(text).toContain("Даже при недоступности MCP");
    expect(text).toContain("помести состояние в `### 1.`");
    expect(text).toContain("без поясняющей фразы");
    expect(text).toContain("[Использованы библиотеки: нет]");
    expect(text.toLowerCase()).toContain("последней строкой без текста после неё");
  });

  it("contains routing keywords but no concrete example questions", () => {
    expect(text).not.toContain("?");
    expect(text).not.toMatch(/пример(?:ы)? вопрос/iu);
    expect(text).not.toMatch(/пользователь спрашивает/iu);
    expect(text).not.toContain('library="');
  });

  it("is user-invoked and declares the lib-docs MCP dependency", () => {
    expect(text).not.toContain("disable-model-invocation");
    expect(agent).toContain('value: "lib-docs"');
    expect(agent).toContain("allow_implicit_invocation: false");
  });

  it("routes by project and folder through the disclosed library map", () => {
    expect(text).toContain("references/library-map.md");
    expect(text).toContain("## Выбрать библиотеки");
    expect(text).toContain("Работай только после ручного вызова `$lib-project-docs`");
    expect(text).toContain("sap_process_navigator");
    expect(text).toContain("onec_erp");
    expect(map).toContain("Раздел 07 у Полюса отсутствует");
    expect(requiredLibraries).toHaveLength(22);
    for (const library of requiredLibraries) {
      expect(map.match(new RegExp(library, "g"))).toHaveLength(1);
    }
  });

  it("searches the Russian index instead of translating to English", () => {
    expect(text).toContain("русск");
    expect(text).toContain("Не переводи запрос в английский");
    expect(text).toContain('targetVersion="1.0.0"');
  });

  it("distinguishes matched artifacts and representation limits", () => {
    expect(text).toContain("Matched Artifacts");
    expect(text).toContain("Related Artifacts");
    expect(text).toContain("Missing");
    expect(text).toContain("ExternalUnresolved");
    expect(text).toContain("xlsx-metadata");
    expect(text).toContain("unsupported-metadata");
  });

  it("retrieves source bytes only through an opaque artifactId", () => {
    expect(text).toContain("list_source_artifacts");
    expect(text).toContain("get_source_artifact");
    expect(text).toContain("artifactId");
    expect(text).toContain("Не принимай от пользователя путь сервера");
    expect(text).toContain("Получай байты только через `get_source_artifact`");
  });

  it("groups a concise final artifact list by catalog type", () => {
    expect(text).toContain("## Артефакты");
    expect(text).toContain("Документы");
    expect(text).toContain("Таблицы");
    expect(text).toContain("Презентации");
    expect(text).toContain("Планы проекта");
    expect(text).toContain("Оставь названия групп и разделителей обычным текстом");
    expect(text).toContain("для `Downloaded` только `suggestedFilename`");
    expect(text).toContain("для недоступной записи — её `name`");
    expect(text).toContain("Не выводи пустые группы");
    expect(text).toContain("не показывай `artifactId`");
    expect(text).toContain("`list_source_artifacts` один раз для каждого подтверждённого раздела");
    expect(text).toContain("полный массив `structuredContent.artifacts`");
    expect(text).toContain("инвентарём выбранного раздела");
    expect(text).toContain("<Клиент> — <Раздел>");
    expect(text).toContain("При нескольких разделах внутри каждой группы");
  });

  it("uses a deterministic destination policy for requested downloads", () => {
    expect(text).toContain("`artifacts/project-docs/<проект>/<nn-slug>/`");
    expect(text).toContain("Если проектная папка не найдена");
    expect(text).toContain("предложи рабочий стол как вариант по умолчанию");
    expect(text).toContain("разреши относительный путь от текущей рабочей папки");
    expect(text).toContain("`.git`, `package.json`, `pyproject.toml`");
    expect(text).toContain("Сначала определи папку назначения");
    expect(text).toContain("остановись до ответа");
    expect(text).toContain("Bundled writer сам");
    expect(text).toContain("сохраняет через `create-new`");
    expect(text).toContain("без временных файлов и удаления");
    expect(text).toContain("**Скачано**");
    expect(text).toContain("по одной строке `имя файла → полный путь`");
  });

  it("uses one bundled fast-path writer after parallel artifact retrieval", () => {
    expect(text).toContain("`scripts/save-source-artifacts.mjs`");
    expect(text).toContain("параллельно одним batch");
    expect(text).toContain("После завершения всех retrieval-вызовов");
    expect(text).toContain("запусти writer один раз");
    expect(text).toContain("Не генерируй inline Python");
    expect(text).toContain("не запускай диагностические sleep/probe-команды");
    expect(text).toContain("В Codex сразу используй интерактивный режим");
    expect(text).toContain('JSON `{"ready":true}`');
    expect(text).toContain("Сохраняю {количество} файлов в {папка}");
    expect(text).toContain("`- [имя файла](<абсолютный путь>)`");
  });

  it("passes the applicable combining validator", () => {
    const combining = spawnSync(
      "python3",
      [resolve(skillDir, "scripts/validate_project_docs_skill.py"), skillDir],
      { encoding: "utf8" },
    );
    expect(combining.status).toBe(0);
    expect(combining.stdout).toContain("PASS");
  });

  it("uses its project writer with PPTX, DOC, and MPP checks", () => {
    const projectWriter = resolve(skillDir, "scripts/save-source-artifacts.mjs");
    const destination = mkdtempSync(join(tmpdir(), "project-docs-writer-"));
    const pptx = Buffer.concat([
      Buffer.from("PK"),
      Buffer.from("ppt/slides/slide1.xml"),
    ]);
    try {
      const input = `${JSON.stringify({
        suggestedFilename: "deck.pptx",
        blob: pptx.toString("base64"),
        sizeBytes: pptx.length,
        sha256: createHash("sha256").update(pptx).digest("hex"),
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      })}\n`;
      const output = execFileSync(
        process.execPath,
        [projectWriter, "--destination", destination, "--count", "1"],
        { encoding: "utf8", input },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(output).toEqual([
        { ready: true, count: 1 },
        {
          name: "deck.pptx",
          path: join(destination, "deck.pptx"),
          status: "saved",
        },
      ]);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it("maps seven live Russian scenarios onto published project-docs libraries", () => {
    expect(matrix.map(({ id }) => id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `PD-0${index + 1}`),
    );
    expect(matrix.every(({ promptRu }) => /[А-Яа-яЁё]/u.test(promptRu))).toBe(true);
    expect(matrix.every(({ mustContain }) => mustContain.length > 0)).toBe(true);
    expect(matrix.every(({ refinements }) => refinements.length <= 2)).toBe(true);
    expect(matrix.every(({ libraries }) => libraries.length >= 1 && libraries.length <= 3)).toBe(
      true,
    );
  });

  it("records a grounded Russian verdict for all seven scenarios", () => {
    const matrixById = new Map(matrix.map((acceptanceCase) => [acceptanceCase.id, acceptanceCase]));
    expect(observations.cases).toHaveLength(7);
    expect(observations.cases.map(({ id }) => id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `PD-0${index + 1}`),
    );
    for (const observation of observations.cases) {
      const acceptanceCase = matrixById.get(observation.id);
      const finalQuery = observation.queries.at(-1);
      expect(acceptanceCase).toBeDefined();
      expect(observation.queries.map(({ query }) => query)).toEqual([
        acceptanceCase?.initialQuery,
        ...(acceptanceCase?.refinements ?? []),
      ]);
      expect(
        observation.queries.every(
          ({ library, limit }) =>
            (acceptanceCase?.libraries.includes(library) ?? false) &&
            (limit === 5 || limit === 10),
        ),
      ).toBe(true);
      expect(finalQuery?.rank).toBeGreaterThanOrEqual(1);
      expect(finalQuery?.rank).toBeLessThanOrEqual(5);
      expect(
        observation.queries.some(({ topProcessIds }) =>
          topProcessIds.includes(acceptanceCase?.expectedProcessId ?? ""),
        ),
      ).toBe(true);
      expect(observation.matchedArtifact.name).toBe(acceptanceCase?.expectedArtifactName);
      expect(observation.matchedArtifact.availability).toBe("Downloaded");
      expect(observation.answerRu).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it("keeps four factual scenarios free of source retrieval", () => {
    const factualIds = matrix
      .filter(({ retrieveSource }) => !retrieveSource)
      .map(({ id }) => id);
    expect(factualIds).toHaveLength(4);
    expect(
      observations.cases
        .filter(({ id }) => factualIds.includes(id))
        .every(({ retrieval }) => retrieval === null),
    ).toBe(true);
  });

  it("records one saved and hash-verified source for docx, pptx, and mpp", () => {
    const sourceCases = matrix.filter(({ retrieveSource }) => retrieveSource);
    const resultById = new Map(observations.cases.map((result) => [result.id, result]));
    expect(sourceCases.map(({ representationType }) => representationType).sort()).toEqual(
      ["docx-text", "pptx-text", "unsupported-metadata"],
    );
    for (const acceptanceCase of sourceCases) {
      const retrieval = resultById.get(acceptanceCase.id)?.retrieval;
      expect(retrieval).toMatchObject(acceptanceCase.expectedSource ?? {});
      expect(retrieval?.sizeBytes).toBeGreaterThan(0);
      expect(retrieval?.savedSha256).toBe(retrieval?.catalogSha256);
      expect(retrieval?.temporaryCopyRemoved).toBe(false);
    }
  });

  it("records Matched and Related Artifact observations separately", () => {
    const resultsById = new Map(observations.cases.map((result) => [result.id, result]));
    expect(traces.relatedEvidence.length).toBeGreaterThan(0);
    for (const related of traces.relatedEvidence) {
      expect(related.artifactId).not.toBe(resultsById.get(related.id)?.matchedArtifact.artifactId);
      expect(["Downloaded", "Missing", "ExternalUnresolved"]).toContain(related.availability);
      expect(related.retrieved).toBe(false);
    }
  });

  it("records ordered version-first bounded searches including a two-library cut-over", () => {
    expect(traces.scenarioTraces).toHaveLength(7);
    for (const trace of traces.scenarioTraces) {
      expect(trace.events.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: trace.events.length }, (_, index) => index + 1),
      );
      expect(trace.events[0]).toMatchObject({ tool: "find_version" });
      expect(
        trace.events
          .filter(({ tool }) => tool === "search_docs")
          .every(
            ({ arguments: toolArguments }) =>
              String(toolArguments.library).startsWith("project-docs-") &&
              toolArguments.version === "1.0.0" &&
              (toolArguments.limit === 5 || toolArguments.limit === 10),
          ),
      ).toBe(true);
      expect(trace.events.every(({ arguments: toolArguments }) => {
        const library = toolArguments.library;
        return typeof library !== "string" || !library.includes("sap_process_navigator");
      })).toBe(true);
    }
    const combining = traces.scenarioTraces.find(({ id }) => id === "PD-07");
    expect(
      combining?.events.filter(({ tool }) => tool === "search_docs").map(
        ({ arguments: toolArguments }) => toolArguments.library,
      ),
    ).toEqual(["project-docs-mane-11-cutover", "project-docs-polis-11-cutover"]);
  });

  it("records a fresh ambiguity clarification with zero MCP calls", () => {
    expect(traces.supplementalBlindContext.answerRu).toContain("ЛЮВЕ");
    expect(traces.supplementalBlindContext.toolCalls).toEqual([]);
  });

  it("records honest unavailable statuses without blobs", () => {
    expect(
      new Set(observations.unavailableEvidence.map(({ availability }) => availability)),
    ).toEqual(new Set(["Missing", "ExternalUnresolved"]));
    expect(
      observations.unavailableEvidence.every(({ blobReturned }) => !blobReturned),
    ).toBe(true);
  });

  it("records the exact closed read-only MCP surface", () => {
    expect(observations.runtime).toMatchObject({
      family: "project-docs",
      version: "1.0.0",
      sourceRelease: "2026.8.21",
      toolSurface: [
        "find_version",
        "get_source_artifact",
        "list_libraries",
        "list_source_artifacts",
        "search_docs",
      ],
    });
  });

  it("records no sensitive payloads in sanitized evidence", () => {
    expect(observations.negativeEvidence).toMatchObject({
      rawBinaryOrBase64Recorded: false,
      privateUrlRecorded: false,
      serverPathRecorded: false,
    });
  });

  it("installs the canonical skill into the global Codex skills directory", () => {
    const installed = resolve(homedir(), ".codex/skills/lib-project-docs");
    const files = [
      "SKILL.md",
      "agents/openai.yaml",
      "references/library-map.md",
      "scripts/save-source-artifacts.mjs",
      "scripts/validate_project_docs_skill.py",
    ];
    for (const file of files) {
      expect(readFileSync(join(installed, file))).toEqual(
        readFileSync(join(skillDir, file)),
      );
    }
    expect(observations.runtime.publication).toMatchObject({
      installedPath: "~/.codex/skills/lib-project-docs",
      canonicalEqualsInstalled: true,
      combiningValidate: "PASS",
      oneLibraryValidate: "N/A",
    });
  });
});
