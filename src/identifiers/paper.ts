import type {
  CitationIdentifierKind,
  CitationIdentifiers,
} from "../providers/sdk/types.js";
import { CITATION_IDENTIFIER_KINDS } from "../providers/sdk/types.js";

const DOI_PREFIX_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/iu;
const ARXIV_PREFIX_RE = /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/iu;

export class ExactIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactIdentifierError";
  }
}

export function normalizeDoi(value: string): string {
  return value.replace(DOI_PREFIX_RE, "").trim().toLowerCase();
}

export function normalizeArxiv(value: string): string {
  return value
    .replace(ARXIV_PREFIX_RE, "")
    .replace(/\.pdf$/iu, "")
    .trim()
    .toLowerCase()
    .replace(/v\d+$/u, "");
}

export function normalizeExactIdentifier(
  kind: CitationIdentifierKind,
  value: string,
): string {
  if (typeof value !== "string") {
    throw new ExactIdentifierError(`${kind} identifier must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new ExactIdentifierError(`${kind} identifier cannot be blank`);
  switch (kind) {
    case "doi": {
      const normalized = normalizeDoi(trimmed);
      if (!/^10\.\d{4,9}\/\S+$/u.test(normalized)) {
        throw new ExactIdentifierError(`Invalid DOI identifier: ${value}`);
      }
      return normalized;
    }
    case "pmid":
      if (!/^\d{1,12}$/u.test(trimmed)) {
        throw new ExactIdentifierError(`Invalid PMID identifier: ${value}`);
      }
      return trimmed.replace(/^0+(?=\d)/u, "");
    case "arxiv": {
      const normalized = normalizeArxiv(trimmed);
      if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/u.test(normalized)) {
        throw new ExactIdentifierError(`Invalid arXiv identifier: ${value}`);
      }
      return normalized;
    }
    case "semantic":
    case "openalex":
    case "scopus":
      return trimmed.toLowerCase();
  }
}

export function normalizeCitationIdentifiers(
  identifiers: CitationIdentifiers,
  options: { exactlyOne?: boolean } = {},
): CitationIdentifiers {
  if (!identifiers || typeof identifiers !== "object" || Array.isArray(identifiers)) {
    throw new ExactIdentifierError("Citation identifiers must be an object");
  }
  const allowed = new Set<string>(CITATION_IDENTIFIER_KINDS);
  const unknownKeys = Object.keys(identifiers).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new ExactIdentifierError(`Unknown citation identifier kind: ${unknownKeys.join(", ")}`);
  }
  const result: CitationIdentifiers = {};
  for (const kind of CITATION_IDENTIFIER_KINDS) {
    const value = identifiers[kind];
    if (value === undefined) continue;
    result[kind] = normalizeExactIdentifier(kind, value);
  }
  const count = Object.keys(result).length;
  if (count === 0) throw new ExactIdentifierError("At least one exact citation identifier is required");
  if (options.exactlyOne && count !== 1) {
    throw new ExactIdentifierError("Exactly one typed citation identifier is required");
  }
  return result;
}

export function citationIdentifierAliases(
  identifiers: CitationIdentifiers,
): string[] {
  return CITATION_IDENTIFIER_KINDS.flatMap((kind) => {
    const value = identifiers[kind];
    return value === undefined ? [] : [`${kind}:${value}`];
  });
}
