/**
 * Unified result envelope. Every capability command and canonical tool should
 * return this single shape so agents parse one structure and the skill does not
 * need per-command output checklists (a known source of doc/implementation
 * drift). Human-facing formatting is applied on top of the envelope; the
 * envelope itself is the machine contract.
 */

import type { CapabilityGroup } from "./capabilities.js";

export interface ResultDiagnostics {
  /** Per-source result counts for merged/multi-source operations. */
  sourceCounts?: Record<string, number>;
  /** Sources that failed in a partial-failure operation. */
  failedSources?: string[];
  /** Elapsed wall-clock time in milliseconds, when measured. */
  elapsedMs?: number;
  [key: string]: unknown;
}

export interface ResultProvenance {
  /** Material/search provider ids that contributed to the result. */
  providerIds?: string[];
  /** Named user/deployment policy that authorized a write or network action. */
  policy?: string;
  /** Config file paths that affected this result, for reproducibility. */
  configPaths?: string[];
  [key: string]: unknown;
}

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  /** Capability group this result belongs to. */
  capability: CapabilityGroup;
  /** Canonical tool name that produced the result. */
  tool: string;
  /** Whether this was a dry-run/plan rather than an executed action. */
  planned?: boolean;
  /** Capability-specific payload. Null on failure. */
  data: T | null;
  diagnostics?: ResultDiagnostics;
  warnings?: string[];
  errors?: string[];
  provenance?: ResultProvenance;
}

export interface EnvelopeInit<T> {
  capability: CapabilityGroup;
  tool: string;
  data: T;
  planned?: boolean;
  diagnostics?: ResultDiagnostics;
  warnings?: string[];
  provenance?: ResultProvenance;
}

export function okEnvelope<T>(init: EnvelopeInit<T>): ResultEnvelope<T> {
  return {
    ok: true,
    capability: init.capability,
    tool: init.tool,
    ...(init.planned !== undefined ? { planned: init.planned } : {}),
    data: init.data,
    ...(init.diagnostics ? { diagnostics: init.diagnostics } : {}),
    ...(init.warnings && init.warnings.length > 0 ? { warnings: init.warnings } : {}),
    ...(init.provenance ? { provenance: init.provenance } : {}),
  };
}

export function failEnvelope(init: {
  capability: CapabilityGroup;
  tool: string;
  errors: string[];
  warnings?: string[];
  diagnostics?: ResultDiagnostics;
  provenance?: ResultProvenance;
}): ResultEnvelope<null> {
  return {
    ok: false,
    capability: init.capability,
    tool: init.tool,
    data: null,
    ...(init.diagnostics ? { diagnostics: init.diagnostics } : {}),
    ...(init.warnings && init.warnings.length > 0 ? { warnings: init.warnings } : {}),
    errors: init.errors,
    ...(init.provenance ? { provenance: init.provenance } : {}),
  };
}

export function isResultEnvelope(value: unknown): value is ResultEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ok === "boolean" &&
    typeof candidate.capability === "string" &&
    typeof candidate.tool === "string" &&
    "data" in candidate
  );
}
