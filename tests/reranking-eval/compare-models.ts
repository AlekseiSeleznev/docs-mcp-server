import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { CircuitBreakingReranker } from "../../src/store/CircuitBreakingReranker";
import { DocumentRetrieverService } from "../../src/store/DocumentRetrieverService";
import { DocumentStore } from "../../src/store/DocumentStore";
import type { RerankCandidate, Reranker, RerankResult } from "../../src/store/Reranker";
import { VoyageReranker, VoyageRerankerError } from "../../src/store/VoyageReranker";
import { AppConfigSchema } from "../../src/utils/config";
import { LogLevel, setLogLevel } from "../../src/utils/logger";
import {
  buildModeSummary,
  compareModeOutcomes,
  loadLockedDataset,
  MATERIAL_BENEFIT_ABSOLUTE,
  type ModeSummary,
  ObservedForcedFailOpenReranker,
  type QueryMeasurement,
  summarizePageEvidence,
} from "./release-gate";

const DATASET_SHA256 = "6e048569089ec05445f73a1d67975290bc7554357a691e7c0c8d053a802161c5";
const MODELS = ["rerank-2.5-lite", "rerank-3-lite"] as const;
const DEADLINE_MS = 5000;
const LIMIT = 30;
const PRICE_PER_MILLION = 0.02;

class ObservedReranker implements Reranker {
  latencyMs = 0;
  usageTokens: number | null = null;
  failure: string | null = null;

  constructor(private readonly delegate: Reranker) {}

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
  ): Promise<RerankResult> {
    const started = performance.now();
    this.usageTokens = null;
    this.failure = null;
    try {
      const result = await this.delegate.rerank(query, candidates);
      this.usageTokens = result.usageTokens ?? null;
      return result;
    } catch (error) {
      this.failure =
        error instanceof VoyageRerankerError ? error.category : "request_failed";
      throw error;
    } finally {
      this.latencyMs = performance.now() - started;
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  setLogLevel(LogLevel.ERROR);
  const dataset = loadLockedDataset(
    fs.readFileSync(requiredEnv("DOCS_RERANK_EVAL_DATASET"), "utf8"),
    DATASET_SHA256,
  );
  const storePath = requiredEnv("DOCS_RERANK_EVAL_STORE");
  const dbPath = path.join(storePath, "documents.db");
  const outputPath = requiredEnv("DOCS_RERANK_EVAL_OUTPUT_JSON");
  const repetitions = Number(process.env.DOCS_RERANK_EVAL_REPETITIONS ?? "2");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error("Invalid repetitions");
  const config = AppConfigSchema.parse({
    app: {
      storePath,
      readOnly: true,
      telemetryEnabled: false,
      embeddingModel: "openai:baai/bge-m3",
    },
    embeddings: { vectorDimension: 1024 },
    search: {
      reranker: {
        enabled: true,
        model: MODELS[0],
        candidateLimit: LIMIT,
        requestTimeoutMs: DEADLINE_MS,
      },
    },
  });
  const corpusBefore = fingerprintCorpus(dbPath);
  const store = new DocumentStore(dbPath, config);
  await store.initialize();
  const baseline: QueryMeasurement[] = [];
  const failOpen: QueryMeasurement[] = [];
  const rounds: Record<string, ModeSummary>[] = [];
  const retrieve = store.findByContent.bind(store);
  const cache = new Map<string, Awaited<ReturnType<typeof retrieve>>>();
  // Both models receive the exact same in-memory candidates and query embedding.
  store.findByContent = async (library, version, query, limit) => {
    const key = JSON.stringify([library, version, query, limit]);
    let candidates = cache.get(key);
    if (!candidates) {
      candidates = await retrieve(library, version, query, limit);
      cache.set(key, candidates);
    }
    return candidates;
  };
  try {
    const baselineService = new DocumentRetrieverService(store, {
      ...config,
      search: {
        ...config.search,
        reranker: { ...config.search.reranker, enabled: false },
      },
    });
    const forced = new ObservedForcedFailOpenReranker();
    const failService = new DocumentRetrieverService(
      store,
      config,
      new CircuitBreakingReranker(forced),
    );
    for (let round = 0; round < repetitions; round++) {
      const measurements: Record<string, QueryMeasurement[]> = Object.fromEntries(
        MODELS.map((model) => [model, []]),
      );
      const observations = MODELS.map(
        (model) =>
          new ObservedReranker(
            new VoyageReranker({
              apiKey: requiredEnv("VOYAGE_API_KEY"),
              model,
              requestTimeoutMs: DEADLINE_MS,
            }),
          ),
      );
      const services = observations.map(
        (reranker, i) =>
          new DocumentRetrieverService(
            store,
            {
              ...config,
              search: {
                ...config.search,
                reranker: { ...config.search.reranker, model: MODELS[i] },
              },
            },
            new CircuitBreakingReranker(reranker),
          ),
      );
      for (let i = 0; i < dataset.entries.length; i++) {
        const entry = dataset.entries[i];
        const candidates = await store.findByContent(
          dataset.library,
          dataset.version,
          entry.query,
          LIMIT,
        );
        const candidateEvidence = summarizePageEvidence(
          candidates.map((candidate) => candidate.url),
        );
        const measure = async (
          service: DocumentRetrieverService,
          observed?: ObservedReranker,
        ): Promise<QueryMeasurement> => {
          const started = performance.now();
          const results = await service.search(
            dataset.library,
            dataset.version,
            entry.query,
            LIMIT,
          );
          const ranked = summarizePageEvidence(
            results.map((result) => result.url),
            true,
          );
          return {
            id: entry.id,
            kind: entry.kind,
            qrels: entry.qrels,
            rankedFiles: ranked.files,
            candidateFiles: candidateEvidence.files,
            candidateCount: candidates.length,
            candidatePageCount: candidateEvidence.pageCount,
            returnedPageCount: ranked.pageCount,
            searchLatencyMs: performance.now() - started,
            rerankerLatencyMs: observed?.latencyMs ?? null,
            usageTokens: observed?.usageTokens ?? null,
            providerFailure: observed?.failure ?? null,
            fallbackCategory: observed?.failure ?? null,
          };
        };
        if (round === 0) {
          baseline.push(await measure(baselineService));
          const failed = await measure(failService);
          failed.fallbackCategory = "request_failed";
          failOpen.push(failed);
        }
        // Alternate request order across queries and repetitions to reduce timing bias.
        for (const j of (i + round) % 2 === 0 ? [0, 1] : [1, 0]) {
          measurements[MODELS[j]].push(await measure(services[j], observations[j]));
        }
        if ((i + 1) % 10 === 0)
          console.log(
            JSON.stringify({ progress: { round: round + 1, completedQueries: i + 1 } }),
          );
      }
      rounds.push(
        Object.fromEntries(
          MODELS.map((model) => [
            model,
            buildModeSummary("rerank-30", measurements[model], PRICE_PER_MILLION),
          ]),
        ),
      );
    }
  } finally {
    await store.shutdown();
  }
  const corpusAfter = fingerprintCorpus(dbPath);
  const baselineSummary = buildModeSummary("baseline", baseline, PRICE_PER_MILLION);
  const failSummary = buildModeSummary("forced-fail-open", failOpen, PRICE_PER_MILLION);
  const checks = {
    corpusUnchanged: corpusBefore === corpusAfter,
    forcedFailOpenMatchesBaseline: baseline.every(
      (query, i) =>
        JSON.stringify(query.rankedFiles) === JSON.stringify(failOpen[i].rankedFiles),
    ),
    complete: rounds.every((round) =>
      MODELS.every((model) => round[model].queryCount === 40),
    ),
    noFailures: rounds.every((round) =>
      MODELS.every(
        (model) =>
          round[model].providerFailures.total === 0 && round[model].fallbacks.total === 0,
      ),
    ),
    acceptanceQuality: rounds.every(
      (round) =>
        round[MODELS[1]].metrics.mrr >= 0.9 && round[MODELS[1]].metrics.ndcgAt5 >= 0.9,
    ),
    noHeadlineRegression: rounds.every((round) => {
      const old = round[MODELS[0]].metrics,
        next = round[MODELS[1]].metrics;
      return (
        next.mrr >= old.mrr &&
        next.ndcgAt5 >= old.ndcgAt5 &&
        next.recallAt30 >= Math.max(old.recallAt30, baselineSummary.metrics.recallAt30)
      );
    }),
    materialBenefitEveryRound: rounds.every((round) => {
      const old = round[MODELS[0]].metrics,
        next = round[MODELS[1]].metrics;
      return (
        next.mrr - old.mrr >= MATERIAL_BENEFIT_ABSOLUTE ||
        next.ndcgAt5 - old.ndcgAt5 >= MATERIAL_BENEFIT_ABSOLUTE
      );
    }),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    datasetSha256: DATASET_SHA256,
    corpusSha256: corpusBefore,
    configuration: {
      models: MODELS,
      repetitions,
      candidateLimit: LIMIT,
      resultLimit: LIMIT,
      deadlineMs: DEADLINE_MS,
      materialBenefitAbsolute: MATERIAL_BENEFIT_ABSOLUTE,
      embeddingModel: "openai:baai/bge-m3",
      vectorDimension: 1024,
      pairedCandidates: true,
      searchLatencyExcludesCachedRetrieval: true,
      pricePerMillionTokensUsd: PRICE_PER_MILLION,
    },
    baseline: baselineSummary,
    failOpen: failSummary,
    rounds,
    comparisons: rounds.map((round) =>
      compareModeOutcomes(round[MODELS[0]], round[MODELS[1]]),
    ),
    checks,
    recommendUpgrade: Object.values(checks).every(Boolean),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({
      checks,
      recommendUpgrade: report.recommendUpgrade,
      comparisons: report.comparisons,
      rounds: rounds.map((round) =>
        Object.fromEntries(
          MODELS.map((model) => [
            model,
            {
              metrics: round[model].metrics,
              providerLatencyMs: round[model].rerankerLatencyMs,
              tokens: round[model].tokens,
              failures: round[model].providerFailures.total,
            },
          ]),
        ),
      ),
    }),
  );
}

function fingerprintCorpus(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.transaction(() => {
      const rows = db
        .prepare(
          "select p.url,p.title,p.content_type,p.source_content_type,p.publication_metadata,d.content,d.metadata,d.embedding from libraries l join versions v on v.library_id=l.id join pages p on p.version_id=v.id join documents d on d.page_id=p.id where lower(l.name)='onec_erp_implementation' and v.name='2026.8.8' order by p.id,d.id",
        )
        .all();
      if (rows.length !== 312) throw new Error("Locked corpus inventory mismatch");
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    })();
  } finally {
    db.close();
  }
}

main().catch(() => {
  console.error("❌ Model comparison failed; private diagnostic details suppressed");
  process.exitCode = 1;
});
