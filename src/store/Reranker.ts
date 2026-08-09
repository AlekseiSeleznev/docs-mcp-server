/** A Search Candidate identified by its stable Baseline Ranking index. */
export interface RerankCandidate {
  /** Zero-based position in the Baseline Ranking. */
  index: number;
  /** Raw Search Candidate content before Context Assembly. */
  content: string;
}

/** A provider-neutral relevance score for one Search Candidate. */
export interface RerankScore {
  /** Stable index of the scored Search Candidate. */
  index: number;
  /** Relevance score assigned by the Reranker. */
  score: number;
}

/** Provider-neutral result of scoring a complete Search Candidate set. */
export interface RerankResult {
  /** Complete candidate-to-score mapping. */
  scores: RerankScore[];
  /** Provider-reported processed-token count, when available. */
  usageTokens?: number;
}

/** Reranks raw Search Candidates without exposing provider-specific details. */
export interface Reranker {
  /**
   * Scores Search Candidates for the exact user Search Query.
   * @param query The user's Search Query.
   * @param candidates Raw Search Candidates with stable Baseline Ranking indices.
   * @returns Provider-neutral candidate scores and optional usage metadata.
   */
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult>;
}
