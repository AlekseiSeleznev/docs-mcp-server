import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
      "Никогда не вызывай `fetch_url`, Chromium, browser, инструменты записи или удаления",
    );
    expect(text).toContain(
      "`[Источник] {Официальная публикация}; {Process ID, Process Name или раздел}; <{публичный URL}>`",
    );
    expect(text).toContain(
      "явном контексте процессов SAP",
    );
  });
});
