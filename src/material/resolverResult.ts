/**
 * Runtime validation for artifact_resolver results. Resolvers turn an
 * identifier (DOI first) into ordered candidate artifact locations with
 * provenance; they never fetch artifact bytes. The acquire funnel and
 * resolver-provider contract tests validate provider output through this
 * parser before feeding candidates to downloaders.
 */

import {
  MATERIAL_IDENTIFIER_SCHEMES,
  type MaterialIdentifierInput,
  type MaterialIdentifierScheme,
  type MaterialResolverCandidateLocation,
  type MaterialResolverProvenance,
  type MaterialResolverResult,
} from "./types.js";

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const DOI_RE = /^10\.[^\s/]+\/\S+$/;

export class MaterialResolverResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialResolverResultValidationError";
  }
}

function fail(message: string): never {
  throw new MaterialResolverResultValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string when provided`);
  }
  return value;
}

/** Parse a trimmed string as a DOI identifier input when it matches the resolver DOI shape. */
export function tryParseDoiIdentifier(value: string): MaterialIdentifierInput | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    return validateMaterialIdentifierInput({ scheme: "doi", value: normalized });
  } catch {
    return null;
  }
}

export function validateMaterialIdentifierInput(value: unknown): MaterialIdentifierInput {
  if (!isPlainObject(value)) fail("resolver identifier must be an object");

  const scheme = value.scheme;
  if (!MATERIAL_IDENTIFIER_SCHEMES.includes(scheme as MaterialIdentifierScheme)) {
    fail(`resolver identifier.scheme must be one of: ${MATERIAL_IDENTIFIER_SCHEMES.join(", ")}`);
  }

  const raw = value.value;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail("resolver identifier.value must be a non-empty string");
  }
  const normalized = raw.trim();
  if (scheme === "doi" && !DOI_RE.test(normalized)) {
    fail(`resolver identifier.value is not a valid DOI: ${normalized}`);
  }

  return { scheme: scheme as MaterialIdentifierScheme, value: normalized };
}

function validateCandidate(value: unknown, index: number): MaterialResolverCandidateLocation {
  const label = `resolver candidates[${index}]`;
  if (!isPlainObject(value)) fail(`${label} must be an object`);

  const url = value.url;
  if (typeof url !== "string" || !isHttpUrl(url)) {
    fail(`${label}.url must be an http(s) URL`);
  }

  const license = optionalString(value.license, `${label}.license`);
  const version = optionalString(value.version, `${label}.version`);
  const host = optionalString(value.host, `${label}.host`);
  const contentType = optionalString(value.contentType, `${label}.contentType`);
  const note = optionalString(value.note, `${label}.note`);

  return {
    url,
    ...(license !== undefined ? { license } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

function validateProvenance(value: unknown): MaterialResolverProvenance {
  if (!isPlainObject(value)) fail("resolver provenance must be an object");

  const providerId = value.providerId;
  if (typeof providerId !== "string" || !PROVIDER_ID_RE.test(providerId)) {
    fail("resolver provenance.providerId must be a material provider id");
  }

  const source = optionalString(value.source, "resolver provenance.source");
  const retrievedAt = optionalString(value.retrievedAt, "resolver provenance.retrievedAt");
  if (retrievedAt !== undefined && Number.isNaN(Date.parse(retrievedAt))) {
    fail("resolver provenance.retrievedAt must be an ISO date-time string");
  }

  return {
    providerId,
    ...(source !== undefined ? { source } : {}),
    ...(retrievedAt !== undefined ? { retrievedAt } : {}),
  };
}

/**
 * Validate an artifact_resolver provider result. Candidates keep provider
 * order (best first) and may be empty when the source knows the identifier
 * but has no open location; the acquire funnel decides how to surface that.
 */
export function parseMaterialResolverResult(value: unknown): MaterialResolverResult {
  if (!isPlainObject(value)) fail("resolver result must be an object");

  const identifier = validateMaterialIdentifierInput(value.identifier);

  if (!Array.isArray(value.candidates)) {
    fail("resolver result.candidates must be an array");
  }
  const candidates = value.candidates.map((entry, index) => validateCandidate(entry, index));

  const provenance = validateProvenance(value.provenance);

  return { identifier, candidates, provenance };
}
