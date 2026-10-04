# ONEC reranking release gate

This evaluation runs the immutable 40-query `ONEC_ERP_IMPLEMENTATION` dataset
through Baseline Ranking, Voyage reranking with 30 and 50 Search Candidates,
and forced Fail-open Search. The runner exits non-zero until every release check
for the selected production configuration passes.

## Inputs

The runner requires these environment variables:

- `DOCS_RERANK_EVAL_DATASET`: path to the original dataset whose SHA-256 is
  `6e048569089ec05445f73a1d67975290bc7554357a691e7c0c8d053a802161c5`;
- `DOCS_RERANK_EVAL_STORE`: directory containing a transactionally consistent
  live `documents.db` snapshot;
- `DOCS_RERANK_EVAL_OUTPUT_JSON`: safe full-evidence output path;
- `DOCS_RERANK_EVAL_OUTPUT_MARKDOWN`: safe summary output path;
- `OPENAI_API_KEY` and `OPENAI_API_BASE`: credentials and endpoint for the
  production-equivalent BGE-M3 query embedding provider;
- `VOYAGE_API_KEY`: Voyage credential used by the built-in reranker.

Run under Node.js 22:

```bash
npm run evaluate:reranking
```

The report records safe operational aggregates and sanitized failure categories:
dataset and snapshot hashes, all deterministic metrics and intent breakdowns,
per-query ranks, candidate and page counts, token use, tariff cost, latency
distributions, provider failures, fallback counts, wins/ties/losses, the selected
candidate limit, and every gate.

The runner treats an absolute MRR or nDCG@5 gain of at least `0.01` as material.
When 50 candidates do not reach that threshold without losing Recall@30, the
selected production configuration remains 30 candidates.

## Compare model generations

`compare-models.ts` compares `rerank-2.5-lite` and `rerank-3-lite` on the same
locked dataset and a read-only index. It uses the existing store, Voyage adapter,
circuit breaker, and context assembly. Candidates and query embeddings are
cached in memory and shared by both models. Request order alternates by query
and repetition. The default is two repetitions; `DOCS_RERANK_EVAL_REPETITIONS`
accepts one through five.

The runner uses `DOCS_RERANK_EVAL_DATASET`, `DOCS_RERANK_EVAL_STORE`,
`DOCS_RERANK_EVAL_OUTPUT_JSON`, and the same provider credentials as the release
gate. Run it with Node 22:

```bash
npx vite-node tests/reranking-eval/compare-models.ts
```

The report contains per-query sanitized evidence, provider latency, token use,
and paired wins/ties/losses. Search latency excludes cached candidate retrieval;
provider latency is the comparable timing measure. A corpus digest before and
after evaluation detects concurrent corpus changes without retaining documents
or provider response bodies. Forced fail-open results must match the baseline.

An upgrade recommendation requires a material MRR or nDCG@5 benefit of at least
`0.01` in every repetition, no regression in MRR, nDCG@5, or Recall@30, MRR and
nDCG@5 of at least `0.90`, complete results, and zero provider failures or
fallbacks. These measurements describe this 40-query corpus; they do not
establish statistical significance or coverage of other libraries.
