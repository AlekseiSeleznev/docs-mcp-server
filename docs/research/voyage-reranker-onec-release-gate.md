# Voyage reranking release gate for ONEC_ERP_IMPLEMENTATION

Generated: 2026-08-10T00:27:12.810Z

## Decision

**PASS.** Selected Search Candidate limit: **30** (materially_equivalent).

## Immutable inputs

- Dataset SHA-256: `6e048569089ec05445f73a1d67975290bc7554357a691e7c0c8d053a802161c5`
- Live snapshot SHA-256: `1003db4db1f2e6051c21b508d60886a7bf5c878f246bd52645af48a4b0b66068`
- Corpus: `ONEC_ERP_IMPLEMENTATION@2026.8.8`, 40 queries, 82 pages, 312 chunks
- Retrieval: `openai:baai/bge-m3`, 1024 dimensions
- Reranker: `rerank-2.5-lite`, 5000 ms deadline
- Cost basis: $0.02 per million processed tokens

## Headline and operational evidence

| Mode | MRR | nDCG@5 | Recall@30 | Tokens | Tariff cost | Search latency min/p50/p95/max ms | Provider failures | Fallbacks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 0.682650 | 0.712040 | 1.000000 | 0 | $0.000000 | 157/167/205/424 | 0 | 0 |
| rerank-30 | 0.901667 | 0.908762 | 1.000000 | 702706 | $0.014054 | 581/658/881/1268 | 0 | 0 |
| rerank-50 | 0.900000 | 0.908762 | 0.975000 | 1148646 | $0.022973 | 615/660/760/792 | 0 | 0 |
| forced-fail-open | 0.682650 | 0.712040 | 1.000000 | 0 | $0.000000 | 153/167/178/697 | 0 | 40 |

30 vs Baseline nDCG@5: 15 wins / 20 ties / 5 losses.  
50 vs Baseline nDCG@5: 15 wins / 20 ties / 5 losses.

## Q30 ranks

| Mode | Search Candidate rank | Search Result rank |
|---|---:|---:|
| baseline | 28 | 18 |
| rerank-30 | 28 | 15 |
| rerank-50 | 45 | missing |
| forced-fail-open | 28 | 18 |

## Gate checks

- [x] query_count_40
- [x] unexpected_provider_failures
- [x] unexpected_fallbacks
- [x] selected_recall_at_30_not_worse
- [x] q30_candidate_present_30
- [x] q30_candidate_present_50
- [x] selected_mrr_at_least_0_90
- [x] selected_ndcg_at_5_at_least_0_90
- [x] forced_fail_open_complete

## Full evidence

The sibling JSON report contains every per-query deterministic metric input, intent breakdown, candidate/page count, latency, provider/fallback category, and token total. It contains no credentials, private endpoints, provider bodies, Search Candidate content, or raw error causes.
