# Grounded Documentation Search

This context defines the language used to describe how documentation moves from
retrieval to the results returned to a user.

## Language

**Search Query**:
The user's text that describes the documentation they need.
_Avoid_: Prompt, request

**Search Candidate**:
A raw documentation chunk that can become part of a Search Result.
_Avoid_: Hit, raw result, document

**Baseline Ranking**:
The candidate order produced by the built-in search before optional reranking.
_Avoid_: Old order, fallback order, RRF order

**Reranker**:
An optional external ranking stage that orders Search Candidates by relevance to
the Search Query.
_Avoid_: Embedder, search provider, ranker

**Context Assembly**:
The stage that expands ranked Search Candidates into coherent Search Results.
_Avoid_: Reranking, chunk joining

**Search Result**:
Coherent documentation content returned to the user after ranking and Context
Assembly.
_Avoid_: Search Candidate, raw chunk

**Fail-open Search**:
A search that uses Baseline Ranking when the Reranker cannot return a complete
valid ranking.
_Avoid_: Failed search, partial reranking

**Source Artifact**:
An immutable original file associated with indexed documentation and returned
without content transformation.
_Avoid_: Source, attachment, indexed document

**Artifact Reference**:
The identity, name, media type, and availability of a Source Artifact that is
relevant to a Search Result.
_Avoid_: File path, download URL

**Matched Artifact**:
A Source Artifact whose indexed representation contributed directly to a Search
Result.
_Avoid_: Related Artifact, matching file

**Related Artifact**:
A Source Artifact associated with the same indexed subject as a Search Result
but whose representation did not contribute directly to that result.
_Avoid_: Matched Artifact, nearby file

**Source Release**:
The publisher's label for the documentation set from which a Library Version is
created.
_Avoid_: Library Version

**Library Version**:
An immutable semantic version of an indexed library. It can retain a separate
Source Release label when the publisher does not use semantic versioning.
_Avoid_: Source Release, mutable version
