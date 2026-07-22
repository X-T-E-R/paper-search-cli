import type { AssessmentIdentityEvidence, AssessmentSubject, AssessmentSubjectKind } from "./types.js";

function normalizeIdentifierValue(kind: string, raw: string): string {
  const value = raw.trim();
  switch (kind) {
    case "doi":
      return value
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
        .replace(/^doi:\s*/iu, "")
        .toLowerCase();
    case "pmid":
      return value.replace(/^pmid:\s*/iu, "");
    case "arxiv":
      return value
        .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//iu, "")
        .replace(/\.pdf$/iu, "")
        .replace(/^arxiv:\s*/iu, "")
        .toLowerCase();
    case "issn":
    case "issn-l":
      return value.replace(/-/gu, "").toUpperCase();
    case "openalex":
      return value.replace(/^https?:\/\/openalex\.org\//iu, "").toUpperCase();
    default:
      return value;
  }
}

export function normalizeAssessmentIdentifiers(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawKind, rawValue] of Object.entries(input)) {
    const kind = rawKind.trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(kind)) {
      throw new Error(`Invalid assessment identifier kind: ${rawKind}`);
    }
    const value = normalizeIdentifierValue(kind, rawValue);
    if (!value) throw new Error(`Assessment identifier ${kind} is blank`);
    if (output[kind] !== undefined && output[kind] !== value) {
      throw new Error(`Conflicting assessment identifier values for ${kind}`);
    }
    output[kind] = value;
  }
  if (Object.keys(output).length === 0) throw new Error("Assessment subject requires an exact identifier");
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function assertNormalizedIdentifiers(input: Record<string, string>, label: string): Record<string, string> {
  const normalized = normalizeAssessmentIdentifiers(input);
  const entries = Object.entries(input);
  if (
    entries.length !== Object.keys(normalized).length ||
    entries.some(([kind, value]) => normalized[kind] !== value)
  ) {
    throw new Error(`${label} must use normalized identifier keys and values`);
  }
  return normalized;
}

export function createAssessmentSubject(
  kind: AssessmentSubjectKind,
  identifiers: Record<string, string>,
  preferredIdentifier?: string,
): AssessmentSubject {
  const normalized = normalizeAssessmentIdentifiers(identifiers);
  const selectedKind = preferredIdentifier?.trim().toLowerCase() ?? Object.keys(normalized).sort()[0];
  if (!selectedKind || normalized[selectedKind] === undefined) {
    throw new Error(`Preferred assessment identifier is unavailable: ${preferredIdentifier ?? "(none)"}`);
  }
  return {
    kind,
    canonicalId: `${selectedKind}:${normalized[selectedKind]}`,
    identifiers: normalized,
  };
}

/** Reject title-only or opaque canonical identities at the core comparison boundary. */
export function assertExactAssessmentSubject(subject: AssessmentSubject): void {
  const normalized = assertNormalizedIdentifiers(subject.identifiers, "Assessment subject identifiers");
  const identities = Object.entries(normalized).map(([kind, value]) => `${kind}:${value}`);
  if (!identities.includes(subject.canonicalId)) {
    throw new Error(
      `Assessment subject canonicalId must be derived from an exact identifier (${identities.join(", ")})`,
    );
  }
}

export function assertIdentityEvidence(evidence: AssessmentIdentityEvidence): void {
  const input = assertNormalizedIdentifiers(evidence.inputIdentifiers, "Identity evidence inputIdentifiers");
  if (evidence.matchedSubject) {
    assertExactAssessmentSubject(evidence.matchedSubject);
    const matched = assertNormalizedIdentifiers(
      evidence.matchedIdentifiers ?? {},
      "Identity evidence matchedIdentifiers",
    );
    for (const [kind, value] of Object.entries(matched)) {
      if (evidence.matchedSubject.identifiers[kind] !== value) {
        throw new Error(`Identity evidence matched identifier ${kind} is absent from the matched subject`);
      }
    }
    if (
      evidence.matchMethod === "exact_identifier" &&
      !Object.entries(matched).some(([kind, value]) => input[kind] === value)
    ) {
      throw new Error("Exact identity evidence must share an input and matched identifier");
    }
    if (evidence.matchMethod === "title_only" && (evidence.caveats?.length ?? 0) === 0) {
      throw new Error("Title-only identity evidence requires an explicit caveat");
    }
  }
  for (const candidate of evidence.candidates ?? []) assertExactAssessmentSubject(candidate);
}
