/**
 * Material-provider contracts. Material providers own networked acquisition and
 * extraction adapters, kept outside the CLI core just like search providers.
 * Core owns records, contracts, runtime, and workflow orchestration; external
 * packages own service-specific networking and parsing.
 */

export const MATERIAL_PROVIDER_KINDS = [
  "artifact_resolver", // find candidate artifact URLs from metadata/item/DOI
  "artifact_downloader", // fetch bytes or record a remote artifact
  "extractor", // convert URL/file/artifact into Markdown/JSON/assets
  "converter", // local format conversion, optionally no-network
  "enricher", // add metadata around an artifact/extraction
] as const;

export type MaterialProviderKind = (typeof MATERIAL_PROVIDER_KINDS)[number];

export const MATERIAL_INPUT_KINDS = ["url", "local_file", "artifact", "identifier"] as const;
export type MaterialInputKind = (typeof MATERIAL_INPUT_KINDS)[number];

/**
 * Identifier schemes accepted by "identifier" inputs. DOI first; extend this
 * list deliberately when a resolver for a new scheme lands.
 */
export const MATERIAL_IDENTIFIER_SCHEMES = ["doi"] as const;
export type MaterialIdentifierScheme = (typeof MATERIAL_IDENTIFIER_SCHEMES)[number];

export const MATERIAL_OUTPUT_KINDS = [
  "markdown",
  "json",
  "assets",
  "zip",
  "bytes",
  "locations", // ordered candidate artifact locations produced by artifact_resolver providers
] as const;
export type MaterialOutputKind = (typeof MATERIAL_OUTPUT_KINDS)[number];

export interface MaterialProviderCapabilities {
  inputs: MaterialInputKind[];
  /** Input media types the provider handles, e.g. "pdf", "html", "office", "image". */
  inputTypes?: string[];
  /** Identifier schemes handled; required when inputs include "identifier". */
  identifierSchemes?: MaterialIdentifierScheme[];
  outputs: MaterialOutputKind[];
  /** Whether the provider performs network access. */
  network: boolean;
}

export interface MaterialConfigFieldSchema {
  type: "secret" | "string" | "number" | "boolean";
  default?: string | number | boolean;
  /** Environment variable names that can supply this value (secrets especially). */
  env?: string[];
  label?: string;
  description?: string;
  required?: boolean;
}

export interface MaterialProviderPermissions {
  /** Allowed network URL patterns; required when capabilities.network is true. */
  network?: string[];
  localRead?: boolean;
  /** Local write scope: "none", "cache" (provider-scoped cache only), or "workspace". */
  localWrite?: "none" | "cache" | "workspace";
}

export interface MaterialRateLimit {
  requestsPerMinute?: number;
}

/** Identifier input passed to an artifact_resolver provider. */
export interface MaterialIdentifierInput {
  scheme: MaterialIdentifierScheme;
  value: string;
}

/**
 * One candidate artifact location returned by an artifact_resolver provider.
 * Candidates carry link metadata only; fetching bytes belongs to downloaders.
 */
export interface MaterialResolverCandidateLocation {
  url: string;
  /** License of the hosted copy, e.g. "cc-by". */
  license?: string;
  /** Hosted copy version, e.g. "publishedVersion", "acceptedVersion", "submittedVersion". */
  version?: string;
  /** Hosting venue, e.g. "publisher", "repository", or a repository name. */
  host?: string;
  /** Expected content type of the location, e.g. "application/pdf". */
  contentType?: string;
  /** Free-form note from the resolver about this candidate. */
  note?: string;
}

export interface MaterialResolverProvenance {
  /** Resolver provider id that produced the candidates. */
  providerId: string;
  /** Upstream data source consulted, e.g. "unpaywall". */
  source?: string;
  /** ISO timestamp of when the resolution ran. */
  retrievedAt?: string;
}

/**
 * Result contract for artifact_resolver providers: the resolved identifier,
 * candidate locations ordered best-first, and provenance for auditability.
 */
export interface MaterialResolverResult {
  identifier: MaterialIdentifierInput;
  candidates: MaterialResolverCandidateLocation[];
  provenance: MaterialResolverProvenance;
}

export interface MaterialProviderManifest {
  id: string;
  name: string;
  version: string;
  kind: MaterialProviderKind;
  entry: string;
  description?: string;
  author?: string;
  capabilities: MaterialProviderCapabilities;
  configSchema?: Record<string, MaterialConfigFieldSchema>;
  permissions: MaterialProviderPermissions;
  rateLimit?: MaterialRateLimit;
  integrity?: { sha256?: string };
}
