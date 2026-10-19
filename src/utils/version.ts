/**
 * Version label classification and comparison utilities.
 *
 * A stored version label is whatever an operator indexed documentation under.
 * It is classified into one of two tiers: a *semantic version*, which takes part
 * in ordering and range matching, or an *opaque tag*, which is only ever matched
 * literally. Nothing is discarded — classification is a routing decision, not a
 * judgement about whether a label is valid.
 */

import semver from "semver";

/**
 * Partial versions accepted as stored labels: `major` or `major.minor`, with an
 * optional `v` prefix (e.g. `"5"`, `"1.20"`, `"v1.20"`).
 *
 * Coercion is gated on this shape because `semver.coerce()` pulls the first
 * number out of arbitrary text — it turns `"stable-2024"` into `2024.0.0` and
 * `"node18"` into `18.0.0`, which would make non-version labels sort and match
 * as if they were releases.
 */
const PARTIAL_VERSION_PATTERN = /^v?\d+(?:\.\d+)?$/;

/**
 * Version shapes accepted in a *request*: `major`, `major.minor`, `major.minor.patch`,
 * and their X-range forms (`1.x`, `1.2.x`, `1.x.x`).
 *
 * Wider than {@link PARTIAL_VERSION_PATTERN} because a request may be a range,
 * which a stored label never is. Full semver requests are recognized by
 * `semver.valid` before this pattern is consulted.
 */
export const VERSION_REQUEST_PATTERN = /^\d+(?:\.(?:x(?:\.x)?|\d+(?:\.(?:x|\d+))?))?$/;

/** A stored label that is a semantic version, usable for ordering and ranges. */
export interface SemanticVersionCandidate {
  kind: "version";
  /** The version string exactly as stored in the database. */
  stored: string;
  /** Strict `X.Y.Z[-prerelease]` semver used for range matching and sorting. */
  normalized: string;
  /** True when `stored` was already valid semver and needed no coercion. */
  strict: boolean;
}

/** A stored label that is not a version and can only be matched literally. */
interface TagCandidate {
  kind: "tag";
  /** The label exactly as stored in the database. */
  stored: string;
}

/**
 * A stored version label paired with how it may be matched.
 *
 * Labels in the store are whatever a project publishes — `"1.20"`, `"5"`,
 * `"v2.0.0"`, `"2.0.0-beta"`, but also `"stable"` or `"main"`. Semver range
 * matching only accepts full `X.Y.Z` strings, so a candidate keeps the stored
 * label beside the form used for matching, and records which tier it is in.
 */
export type VersionCandidate = SemanticVersionCandidate | TagCandidate;

/**
 * Classifies a stored version label.
 *
 * Strict semver is matched first and preserved verbatim, so prerelease and build
 * metadata survive and a label like `"2.0.0-beta"` never collapses into
 * `"2.0.0"` and outranks the real release. Only the partial shapes in
 * {@link PARTIAL_VERSION_PATTERN} fall back to coercion. Everything else is an
 * opaque tag.
 *
 * @param stored Version label as stored in the database.
 * @returns The candidate, or `null` for an empty label, which represents
 *   unversioned documentation rather than a tag.
 */
export function toVersionCandidate(stored: string): VersionCandidate | null {
  if (stored === "") {
    return null;
  }

  const strict = semver.valid(stored);
  if (strict) {
    return { kind: "version", stored, normalized: strict, strict: true };
  }

  if (PARTIAL_VERSION_PATTERN.test(stored)) {
    const coerced = semver.coerce(stored);
    if (coerced) {
      return { kind: "version", stored, normalized: coerced.version, strict: false };
    }
  }

  return { kind: "tag", stored };
}

/**
 * Classifies stored version labels, dropping empty ones.
 *
 * @param versions Version labels as stored in the database.
 * @returns One candidate per non-empty label, in input order.
 */
export function toVersionCandidates(versions: string[]): VersionCandidate[] {
  return versions
    .map(toVersionCandidate)
    .filter((candidate): candidate is VersionCandidate => candidate !== null);
}

/** Narrows a candidate to the semantic version tier. */
export function isSemanticVersion(
  candidate: VersionCandidate,
): candidate is SemanticVersionCandidate {
  return candidate.kind === "version";
}

/**
 * Compares two version labels for sorting in the canonical display order.
 *
 * Rules:
 * - Unversioned entries (empty string, null, undefined) sort first.
 * - Semantic versions follow, newest first, compared by semver rules. Labels
 *   that normalize to the same version are ordered strict spelling first.
 * - Opaque tags sort last, in alphabetical order.
 *
 * @param a First version label (may be empty, null, or undefined for unversioned)
 * @param b Second version label (may be empty, null, or undefined for unversioned)
 * @returns Negative if a should come before b, positive if b should come before a, 0 if equal
 */
export function compareVersionsDescending(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const aIsUnversioned = a === "" || a === null || a === undefined;
  const bIsUnversioned = b === "" || b === null || b === undefined;

  // Unversioned entries come first (are "latest")
  if (aIsUnversioned && bIsUnversioned) return 0;
  if (aIsUnversioned) return -1;
  if (bIsUnversioned) return 1;

  // Classify via the same rules used for range matching, so sort order and
  // version resolution never disagree.
  const aCandidate = toVersionCandidate(a);
  const bCandidate = toVersionCandidate(b);
  const aIsVersion = aCandidate?.kind === "version";
  const bIsVersion = bCandidate?.kind === "version";

  if (aIsVersion && bIsVersion) {
    // Both are semantic versions - compare descending (higher version first)
    const byVersion = semver.rcompare(aCandidate.normalized, bCandidate.normalized);
    if (byVersion !== 0) return byVersion;

    // Distinct labels can normalize to the same version ("1.20" and "1.20.0").
    // Order is still required to be deterministic, so prefer the strict
    // spelling — the same one semantic matching resolves to — and fall back to
    // the label itself rather than leaving it to store insertion order.
    if (aCandidate.strict !== bCandidate.strict) return aCandidate.strict ? -1 : 1;
    return aCandidate.stored.localeCompare(bCandidate.stored);
  }

  // Semantic versions outrank opaque tags, which have no defensible position
  // among them.
  if (aIsVersion) return -1;
  if (bIsVersion) return 1;

  // Both are tags - alphabetical, so the order is at least deterministic.
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

/**
 * Sorts version labels into the canonical display order: unversioned first,
 * then semantic versions newest-first, then opaque tags alphabetically.
 *
 * @param versions Array of version labels
 * @returns New array sorted in canonical order
 */
export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort(compareVersionsDescending);
}

/**
 * Resolves stored labels literally, then by semantic range, then a lone opaque tag.
 * @param candidates Classified non-empty labels in the index.
 * @param targetVersion Requested label or supported version range.
 * @returns The stored label, or null when no candidate matches.
 */
export function resolveStoredVersion(
  candidates: VersionCandidate[],
  targetVersion?: string,
): string | null {
  const requested = (targetVersion ?? "").trim().toLowerCase();

  // Rung 1: literal match.
  if (requested !== "") {
    const literal = candidates.find((c) => c.stored === requested);
    if (literal) {
      return literal.stored;
    }
  }

  // Rung 2: semantic version matching.
  const versions = candidates.filter(isSemanticVersion);
  if (versions.length > 0) {
    const matched = matchSemanticVersion(versions, requested);
    if (matched) {
      return matched;
    }
  }

  // Rung 3: a lone opaque tag, only when the caller expressed no preference
  // and there is no semantic version to rank ahead of it. With no semantic
  // versions every candidate is a tag, so one candidate means one tag.
  if (requested === "" && versions.length === 0 && candidates.length === 1) {
    return candidates[0].stored;
  }

  return null;
}

function matchSemanticVersion(
  versions: SemanticVersionCandidate[],
  requested: string,
): string | null {
  const normalizedCandidates = versions.map((c) => c.normalized);
  const options: semver.RangeOptions = { includePrerelease: true };

  let range: string;
  if (requested === "" || requested === "latest") {
    range = "*";
  } else if (semver.valid(requested)) {
    // An exact version: allow matching it OR any older version
    range = `${requested} || <=${requested}`;
  } else if (VERSION_REQUEST_PATTERN.test(requested)) {
    // A partial version or X-range ("1", "1.2", "1.x"): already a valid range
    range = requested;
  } else {
    return null;
  }

  const best = semver.maxSatisfying(normalizedCandidates, range, options);
  if (!best) {
    return null;
  }

  // Map the winning normalized version back to a stored label. Several labels
  // can normalize to the same version ("1.20" and "1.20.0"); rung 1 already
  // handled a caller asking for one by name, so prefer the strict spelling.
  const matches = versions.filter((c) => c.normalized === best);
  return (matches.find((c) => c.strict) ?? matches[0]).stored;
}
