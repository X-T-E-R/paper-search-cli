/**
 * Artifact and extraction record models for the material workflow layer.
 *
 * These are the durable workspace records that sit between bibliographic
 * resources and downstream use:
 *
 *   resource metadata -> artifact acquisition -> extraction -> export / workflow
 *
 * An artifact is a fetched or user-supplied file/URL snapshot. An extraction is
 * derived output (Markdown/JSON/assets) produced from an artifact, URL, or local
 * file. Both record provenance and the policy/provider that produced them so the
 * workflow stays auditable. These models intentionally do not embed any
 * networked acquisition or extraction logic; that lives in material providers.
 */

import type { LocalStorageRefV1 } from "../storage/types.js";

export type ArtifactKind = "pdf" | "html" | "office" | "image" | "bytes" | "auto";

export type ArtifactStatus = "recorded" | "downloaded" | "requested" | "failed";

/** One acquisition attempt against a single tier/source, for auditable fallback. */
export interface ArtifactAttempt {
  tier: string;
  source?: string;
  providerId?: string;
  ok: boolean;
  status?: number;
  message?: string;
  at: string;
}

export interface ArtifactProvenance {
  /** How the artifact entered the workspace. */
  origin: "download" | "user_supplied" | "resolved";
  sourceUrl?: string;
  /** Resolver/downloader material provider id, when one was used. */
  providerId?: string;
  /** artifact_resolver provider that produced candidate locations. */
  resolverProviderId?: string;
  /** Upstream resolver data source, e.g. unpaywall. */
  resolverSource?: string;
  /** Named user/deployment policy that authorized the acquisition. */
  policy?: string;
  resolvedFrom?: string;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  /** Local workspace item id this artifact is attached to, when any. */
  itemId?: string;
  filename?: string;
  contentType?: string;
  /** Workspace-relative path when bytes were stored locally. */
  path?: string;
  /** Versioned location for bytes written outside the workspace record root. */
  storage?: LocalStorageRefV1;
  /** Remote reference kept instead of, or alongside, local bytes. */
  remoteUrl?: string;
  sizeBytes?: number;
  provenance: ArtifactProvenance;
  attempts: ArtifactAttempt[];
  message?: string;
  createdAt: string;
}

export type ExtractionStatus = "extracted" | "requested" | "failed";

export interface ExtractionSource {
  /** What the extraction was run against. */
  kind: "artifact" | "path" | "url";
  artifactId?: string;
  path?: string;
  url?: string;
}

export interface ExtractionOutputs {
  markdownPath?: string;
  jsonPath?: string;
  assetsDir?: string;
  /** Versioned locations used by new extraction writers. Legacy *Path fields remain workspace-relative. */
  markdownStorage?: LocalStorageRefV1;
  jsonStorage?: LocalStorageRefV1;
  assetsStorage?: LocalStorageRefV1;
  /** Optional inline Markdown when the caller requested emit. */
  markdown?: string;
}

export interface ExtractionRecord {
  id: string;
  source: ExtractionSource;
  /** Material extractor provider id that produced this extraction. */
  backend: string;
  status: ExtractionStatus;
  /** Backend-specific options used (model, ocr, language, page ranges, ...). */
  options?: Record<string, unknown>;
  outputs: ExtractionOutputs;
  cacheHit: boolean;
  /** Local workspace item id this extraction is attached to, when any. */
  itemId?: string;
  message?: string;
  createdAt: string;
}
