export const RUN_SCHEMA_VERSION = 1 as const;

export const RUN_KINDS = ["tool", "citation", "assessment"] as const;
export type ResearchRunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "interrupted",
] as const;
export type ResearchRunStatus = (typeof RUN_STATUSES)[number];
export type TerminalRunStatus = Exclude<ResearchRunStatus, "running">;

export interface RunBuildIdentity {
  cliVersion: string;
  sourceCommit?: string;
}

/**
 * The authoritative, bounded v1 durable-run record. All unknown payloads are
 * converted to JSON values and recursively redacted before this shape is ever
 * written to disk.
 */
export interface ResearchRunRecord {
  schemaVersion: 1;
  runId: string;
  kind: ResearchRunKind;
  status: ResearchRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  pinned: boolean;
  request: unknown;
  resolvedSelection?: unknown;
  build: RunBuildIdentity;
  provenance: unknown[];
  attempts: unknown[];
  diagnostics: unknown[];
  result?: unknown;
  checkpoint?: unknown;
  parentRunId?: string;
}

export interface CreateResearchRunInput {
  runId?: string;
  kind: ResearchRunKind;
  request: unknown;
  resolvedSelection?: unknown;
  build: RunBuildIdentity;
  provenance?: readonly unknown[];
  parentRunId?: string;
}

export interface RunProgressUpdate {
  checkpoint?: unknown;
  clearCheckpoint?: boolean;
  appendProvenance?: readonly unknown[];
  appendAttempts?: readonly unknown[];
  appendDiagnostics?: readonly unknown[];
}

export interface FinishResearchRunInput {
  status: TerminalRunStatus;
  result?: unknown;
  checkpoint?: unknown;
  clearCheckpoint?: boolean;
  appendProvenance?: readonly unknown[];
  appendAttempts?: readonly unknown[];
  appendDiagnostics?: readonly unknown[];
}

export interface RunListFilter {
  kind?: ResearchRunKind;
  status?: ResearchRunStatus | "corrupt";
}

export interface RunListEntry {
  runId: string;
  kind?: ResearchRunKind;
  status: ResearchRunStatus | "corrupt";
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  pinned?: boolean;
  bytes: number;
  error?: string;
}

export type PruneExclusionReason =
  | "retention-disabled"
  | "not-old-enough"
  | "pinned"
  | "active"
  | "resumable"
  | "corrupt";

export interface RunPruneCandidate {
  runId: string;
  finishedAt: string;
  ageDays: number;
  bytes: number;
}

export interface RunPruneExclusion {
  runId: string;
  reason: PruneExclusionReason;
  detail?: string;
}

export interface RunPrunePlan {
  planned: true;
  maxAgeDays: number;
  evaluatedAt: string;
  cutoffAt?: string;
  candidates: RunPruneCandidate[];
  exclusions: RunPruneExclusion[];
  totalBytes: number;
}

export interface RunPruneApplyResult extends Omit<RunPrunePlan, "planned"> {
  planned: false;
  deleted: RunPruneCandidate[];
  skipped: RunPruneExclusion[];
  deletedBytes: number;
}

export const RUN_RECORD_LIMITS = Object.freeze({
  recordBytes: 8 * 1024 * 1024,
  requestBytes: 1 * 1024 * 1024,
  resolvedSelectionBytes: 512 * 1024,
  resultBytes: 4 * 1024 * 1024,
  checkpointBytes: 2 * 1024 * 1024,
  arrayBytes: 1 * 1024 * 1024,
  provenanceCount: 200,
  attemptsCount: 200,
  diagnosticsCount: 500,
});
