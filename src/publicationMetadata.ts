/** Bibliographic metadata attached to an indexed book page. */
export interface PublicationMetadata {
  /** Book authors in publication order. */
  authors?: string[];
  /** Year of the indexed edition. */
  year?: number;
}

/** Evidence retained by dry-run and backfill reports. */
export interface PublicationMetadataEvidence {
  authors?: string;
  year?: string;
}

/** Conservative publication extraction result. */
export interface PublicationMetadataExtraction {
  publication?: PublicationMetadata;
  evidence?: PublicationMetadataEvidence;
  conflicts?: {
    authors?: string[][];
    year?: number[];
  };
}

interface PublicationExtractionInput {
  content: string;
  structuredAuthors?: readonly string[] | string | null;
  structuredYear?: unknown;
}

const CONTRIBUTOR_ROLE =
  /\b(editor|edited|copyeditor|proofreader|translator|designer|design|illustrator|reviewer|coordinator|typesetter|foreword|contributor)\b/i;
const AUTHOR_LABEL = /^\s*(?:authors?\b|written\s+by\b|by\b)\s*[:-]?\s*(.+?)\s*$/i;
const VALID_YEAR = /\b(1[5-9]\d{2}|20\d{2}|2100)\b/g;
const NAME_PARTICLE = /^(?:al|da|de|del|der|di|du|la|le|van|von)$/i;
const PROSE_WORD =
  /\b(?:chapter|data|first|for|from|means|nature|organizations?|requirements?|section|system|that|the|this|through|understanding|with)\b/i;

/**
 * Extracts unambiguous authors and publication year from structured metadata and
 * bibliographic text. File creation timestamps are deliberately not accepted.
 */
export function extractPublicationMetadata(
  input: PublicationExtractionInput,
): PublicationMetadataExtraction {
  const authorLevels = [
    authorCandidate(input.structuredAuthors, "structured metadata"),
    extractLocAuthors(input.content),
    extractLabeledAuthors(input.content),
  ];
  const authorSelection = selectAuthors(authorLevels);

  const yearLevels = [
    yearCandidate(input.structuredYear, "structured publication metadata"),
    extractEditionYears(input.content),
    extractYears(
      input.content,
      /\b(?:published\s+by|publication\s+(?:date|year)|publishing|publisher)\b/i,
      /https?:|www\.|\bpages?\b/i,
    ),
    extractYears(input.content, /(?:©|\bcopyright\b)/i),
  ];
  const yearSelection = selectYear(yearLevels);

  const publication: PublicationMetadata = {};
  if (authorSelection.value) publication.authors = authorSelection.value;
  if (yearSelection.value) publication.year = yearSelection.value;

  const evidence: PublicationMetadataEvidence = {};
  if (authorSelection.evidence) evidence.authors = authorSelection.evidence;
  if (yearSelection.evidence) evidence.year = yearSelection.evidence;

  const conflicts: NonNullable<PublicationMetadataExtraction["conflicts"]> = {};
  if (authorSelection.conflict) conflicts.authors = authorSelection.conflict;
  if (yearSelection.conflict) conflicts.year = yearSelection.conflict;

  return {
    ...(Object.keys(publication).length > 0 ? { publication } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}),
  };
}

/** Parses persisted publication metadata while accepting legacy null rows. */
export function parsePublicationMetadata(
  value: unknown,
): PublicationMetadata | undefined {
  if (!value) return undefined;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as { authors?: unknown; year?: unknown };
    const authors = Array.isArray(candidate.authors)
      ? cleanAuthors(
          candidate.authors.filter((item): item is string => typeof item === "string"),
        )
      : [];
    const year = parseYear(candidate.year);
    return authors.length > 0 || year
      ? { ...(authors.length > 0 ? { authors } : {}), ...(year ? { year } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function authorCandidate(
  value: readonly string[] | string | null | undefined,
  evidence: string,
): { values: string[][]; evidence?: string } {
  if (!value) return { values: [] };
  const authors = cleanAuthors(
    typeof value === "string" ? splitAuthors(value) : value.flatMap(splitAuthors),
  );
  return authors.length > 0 ? { values: [authors], evidence } : { values: [] };
}

function extractLocAuthors(content: string): { values: string[][]; evidence?: string } {
  const block = content
    .slice(0, 60_000)
    .match(
      /\bNames:\s*([\s\S]{0,3000}?)(?=\s+(?:Title|Description|Identifiers|Subjects|Classification):|$)/i,
    );
  if (!block?.[1]) return { values: [] };
  const authors = cleanAuthors(
    block[1]
      .split(/\s*\|\s*/)
      .map((part) => part.match(/^(.+?),?\s+author\./i)?.[1])
      .filter((author): author is string => Boolean(author))
      .map(cleanLocAuthor),
  );
  return authors.length > 0
    ? { values: [authors], evidence: `Names: ${block[1].trim()}` }
    : { values: [] };
}

function extractLabeledAuthors(content: string): {
  values: string[][];
  evidence?: string;
} {
  const matches: string[][] = [];
  let evidence: string | undefined;
  for (const line of content.split(/\r?\n/).slice(0, 160)) {
    if (CONTRIBUTOR_ROLE.test(line)) continue;
    const match = line.match(AUTHOR_LABEL);
    if (!match?.[1]) continue;
    const authors = cleanAuthors(splitAuthors(match[1]));
    if (authors.length > 0 && authors.every(looksLikePersonName)) {
      matches.push(authors);
      evidence ??= line.trim();
    }
  }
  return { values: matches, evidence };
}

function cleanLocAuthor(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/,\s*\d{4}(?:-\d{0,4})?\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,+$/, "");
}

function looksLikePersonName(value: string): boolean {
  if (
    value.length > 120 ||
    PROSE_WORD.test(value) ||
    /[^\p{L}\p{M}.'’\-,\s]/u.test(value)
  ) {
    return false;
  }
  const words = value.split(/[\s,]+/).filter(Boolean);
  if (words.length < 2 || words.length > 10) return false;
  return words.every((word) => NAME_PARTICLE.test(word) || /^\p{Lu}/u.test(word));
}

function cleanAuthors(values: string[]): string[] {
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const author = value
      .replace(/^\s*(?:authors?|written\s+by|by)\s*[:-]?\s*/i, "")
      .replace(/\s*\((?:editor|translator|reviewer)[^)]*\)\s*$/i, "")
      .replace(/\s*\(\d{4}[^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.;]+$/, "");
    if (!author || CONTRIBUTOR_ROLE.test(value) || /\d/.test(author)) continue;
    const key = author.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      authors.push(author);
    }
  }
  return authors;
}

function splitAuthors(value: string): string[] {
  const broad = value.split(/\s*(?:;|\||\band\b|&)\s*/i).filter(Boolean);
  if (broad.length > 1) return broad;
  const comma = value.split(/\s*,\s*/).filter(Boolean);
  return comma.length > 1 && comma.every((part) => part.trim().split(/\s+/).length >= 2)
    ? comma
    : [value];
}

function selectAuthors(levels: { values: string[][]; evidence?: string }[]): {
  value?: string[];
  evidence?: string;
  conflict?: string[][];
} {
  for (const level of levels) {
    if (level.values.length === 0) continue;
    const unique = dedupeArrays(level.values);
    return unique.length === 1
      ? { value: unique[0], evidence: level.evidence }
      : { conflict: unique };
  }
  return {};
}

function yearCandidate(
  value: unknown,
  evidence: string,
): { values: number[]; evidence?: string } {
  const year = parseYear(value);
  return year ? { values: [year], evidence } : { values: [] };
}

function extractYears(
  content: string,
  marker: RegExp,
  forbidden?: RegExp,
): { values: number[]; evidence?: string } {
  const values: number[] = [];
  let evidence: string | undefined;
  for (const line of content.slice(0, 60_000).split(/\r?\n/)) {
    if (
      line.length > 500 ||
      /\b(?:isbn|sbn|named after)\b/i.test(line) ||
      forbidden?.test(line) ||
      !marker.test(line)
    )
      continue;
    if (/\bedition\b/i.test(line) && (line.match(/\bedition\b/gi)?.length ?? 0) > 1) {
      continue;
    }
    const markerIndex = line.search(marker);
    const years = [...line.matchAll(VALID_YEAR)]
      .filter((match) => Math.abs((match.index ?? 0) - markerIndex) <= 120)
      .map((match) => Number(match[1]))
      .filter(isReasonableYear);
    if (years.length > 0) {
      values.push(...years);
      evidence ??= line.trim();
    }
  }
  return { values: [...new Set(values)], evidence };
}

function extractEditionYears(content: string): {
  values: number[];
  evidence?: string;
} {
  const values: number[] = [];
  let evidence: string | undefined;
  for (const line of content.slice(0, 60_000).split(/\r?\n/)) {
    if (
      line.length > 250 ||
      /https?:|www\.|\b(?:contributed|hardcover|isbn|paperback|pages?|pp|released|sbn)\b/i.test(
        line,
      ) ||
      (line.match(/\bedition\b/gi)?.length ?? 0) > 1
    ) {
      continue;
    }
    for (const match of line.matchAll(VALID_YEAR)) {
      const index = match.index ?? 0;
      const before = line.slice(Math.max(0, index - 80), index);
      const after = line.slice(index + match[0].length, index + match[0].length + 20);
      const isEditionYear =
        /\b(?:\d{1,2}(?:st|nd|rd|th)|first|second|third|revised|updated)\b[^.]{0,40}\bedition\b[^\d]{0,20}$/i.test(
          before,
        ) ||
        /\bedition\b[^\d]{0,10}$/i.test(before) ||
        /^\D{0,10}\bedition\b/i.test(after);
      const year = Number(match[1]);
      if (!isEditionYear || !isReasonableYear(year)) continue;
      values.push(year);
      evidence ??= line.trim();
    }
  }
  return { values: [...new Set(values)], evidence };
}

function selectYear(levels: { values: number[]; evidence?: string }[]): {
  value?: number;
  evidence?: string;
  conflict?: number[];
} {
  for (const level of levels) {
    const unique = [...new Set(level.values)];
    if (unique.length === 0) continue;
    return unique.length === 1
      ? { value: unique[0], evidence: level.evidence }
      : { conflict: unique.sort((a, b) => a - b) };
  }
  return {};
}

function parseYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && isReasonableYear(value)) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const match = value.match(VALID_YEAR);
  const year = match?.[1] ? Number(match[1]) : undefined;
  return year && isReasonableYear(year) ? year : undefined;
}

function isReasonableYear(year: number): boolean {
  return year >= 1500 && year <= new Date().getUTCFullYear() + 1;
}

function dedupeArrays(values: string[][]): string[][] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.map((item) => item.toLocaleLowerCase()).join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
