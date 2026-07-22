import path from "node:path";
import { canonicalJson, digestJson, type JsonValue } from "./canonical.js";
import { reduceAssessmentConflicts } from "./conflicts.js";
import { assertExactAssessmentSubject, assertIdentityEvidence } from "./identity.js";
import { evaluateAssessmentPolicy, validateAssessmentPolicy, type ValidatedAssessmentPolicy } from "./policy.js";
import { loadAssessmentSnapshot } from "./snapshot.js";
import type {
  AssessmentIdentityEvidence,
  AssessmentObservation,
  AssessmentReport,
  AssessmentRunPayload,
  AssessmentSnapshotRef,
  LoadedAssessmentSnapshot,
} from "./types.js";
import {
  parseAssessmentIdentityEvidence,
  parseAssessmentObservation,
  parseAssessmentPolicy,
} from "./validation.js";

export interface AssessmentRequest {
  snapshot: AssessmentSnapshotRef;
  /** A validated object, not a path. Policy-file loading belongs to the surface/config adapter. */
  policy?: unknown;
}

export interface AssessmentRunStoreStart {
  tool: "assessment_run";
  request: AssessmentRunPayload["request"];
}

export interface AssessmentRunStoreStarted {
  runId: string;
  createdAt: string;
}

/** Narrow bridge for the shared run owner; assessment never owns a second database. */
export interface AssessmentRunStore {
  startAssessmentRun(input: AssessmentRunStoreStart): Promise<AssessmentRunStoreStarted>;
  completeAssessmentRun(runId: string, payload: AssessmentRunPayload): Promise<{ terminalAt: string }>;
  failAssessmentRun(runId: string, error: unknown): Promise<{ terminalAt: string }>;
  readAssessmentRun(runId: string): Promise<{ runId: string; payload: unknown }>;
}

export interface AssessmentPlanResult {
  planned: true;
  runId: null;
  report: AssessmentReport;
}

export interface AssessmentExecutionResult {
  planned: false;
  runId: string;
  createdAt: string;
  report: AssessmentReport;
}

function assertInstant(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 instant`);
  }
}

function reportDigestInput(report: Omit<AssessmentReport, "resultDigest">): JsonValue {
  return {
    schemaVersion: report.schemaVersion,
    snapshot: {
      snapshotId: report.snapshot.snapshotId,
      sha256: report.snapshot.sha256,
      canonicalDigest: report.snapshot.canonicalDigest,
      createdAt: report.snapshot.createdAt,
      source: report.snapshot.source,
    },
    identityEvidence: report.identityEvidence as unknown as JsonValue,
    observations: report.observations as unknown as JsonValue,
    conflicts: report.conflicts as unknown as JsonValue,
    policy: report.policy as unknown as JsonValue,
    evaluation: report.evaluation as unknown as JsonValue,
  };
}

function buildReport(
  snapshot: AssessmentReport["snapshot"],
  identityEvidence: AssessmentIdentityEvidence[],
  observations: AssessmentObservation[],
  validatedPolicy: ValidatedAssessmentPolicy | null,
): AssessmentReport {
  const conflicts = reduceAssessmentConflicts(observations);
  const policy = validatedPolicy ? { ...validatedPolicy.policy, digest: validatedPolicy.digest } : null;
  const evaluation = validatedPolicy
    ? evaluateAssessmentPolicy(validatedPolicy, observations, conflicts)
    : null;
  const withoutDigest: Omit<AssessmentReport, "resultDigest"> = {
    schemaVersion: 1,
    snapshot,
    identityEvidence,
    observations,
    conflicts,
    policy,
    evaluation,
  };
  return { ...withoutDigest, resultDigest: digestJson(reportDigestInput(withoutDigest)) };
}

async function prepareAssessment(
  request: AssessmentRequest,
  policyOverride?: ValidatedAssessmentPolicy | null,
): Promise<{
  report: AssessmentReport;
  policyDigest: string | null;
}> {
  const loaded = await loadAssessmentSnapshot(request.snapshot);
  const policy = policyOverride ?? (request.policy === undefined ? null : validateAssessmentPolicy(request.policy));
  const report = buildReport(
    {
      ...loaded.ref,
      snapshotId: loaded.snapshot.snapshotId,
      canonicalDigest: loaded.canonicalDigest,
      createdAt: loaded.snapshot.createdAt,
      source: loaded.snapshot.source,
    },
    [...loaded.snapshot.identityEvidence],
    [...loaded.snapshot.observations],
    policy,
  );
  return { report, policyDigest: policy?.digest ?? null };
}

export async function planAssessment(request: AssessmentRequest): Promise<AssessmentPlanResult> {
  const prepared = await prepareAssessment(request);
  return { planned: true, runId: null, report: prepared.report };
}

export async function runAssessment(
  request: AssessmentRequest,
  store: AssessmentRunStore,
): Promise<AssessmentExecutionResult> {
  const policy = request.policy === undefined ? null : validateAssessmentPolicy(request.policy);
  const runRequest: AssessmentRunPayload["request"] = {
    snapshot: { path: path.resolve(request.snapshot.path), sha256: request.snapshot.sha256.toLowerCase() },
    policyDigest: policy?.digest ?? null,
  };
  const created = await store.startAssessmentRun({
    tool: "assessment_run",
    request: runRequest,
  });
  if (!created.runId.trim()) throw new Error("Common run store returned a blank assessment run id");
  assertInstant(created.createdAt, "Common assessment run createdAt");
  try {
    const prepared = await prepareAssessment(request, policy);
    const payload: AssessmentRunPayload = {
      schemaVersion: 1,
      kind: "assessment",
      request: runRequest,
      report: prepared.report,
    };
    const finished = await store.completeAssessmentRun(created.runId, payload);
    assertInstant(finished.terminalAt, "Common assessment run terminalAt");
    return { planned: false, runId: created.runId, createdAt: created.createdAt, report: prepared.report };
  } catch (error) {
    try {
      await store.failAssessmentRun(created.runId, error);
    } catch (persistenceError) {
      throw new AggregateError(
        [error, persistenceError],
        `Assessment run ${created.runId} failed and its common run could not be finalized`,
      );
    }
    throw error;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid ${label}: expected a string`);
  return value;
}

function validateStoredReport(value: unknown): AssessmentReport {
  const stored = requireRecord(value, "stored assessment report");
  if (stored.schemaVersion !== 1) throw new Error("Invalid stored assessment report: unsupported schemaVersion");
  const snapshot = requireRecord(stored.snapshot, "stored assessment snapshot reference");
  const path = requireString(snapshot.path, "stored assessment snapshot path");
  const sha256 = requireString(snapshot.sha256, "stored assessment snapshot sha256").toLowerCase();
  const snapshotId = requireString(snapshot.snapshotId, "stored assessment snapshot id");
  const canonicalDigest = requireString(snapshot.canonicalDigest, "stored assessment snapshot canonical digest").toLowerCase();
  const createdAt = requireString(snapshot.createdAt, "stored assessment snapshot createdAt");
  assertInstant(createdAt, "Stored assessment snapshot createdAt");
  const source = requireRecord(snapshot.source, "stored assessment snapshot source");
  const providerId = requireString(source.providerId, "stored assessment snapshot providerId");
  const providerVersion = requireString(source.providerVersion, "stored assessment snapshot providerVersion");
  if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(providerId) || source.sourceKind !== "user-snapshot") {
    throw new Error("Invalid stored assessment report: snapshot source identity is invalid");
  }
  const datasetVersion = source.datasetVersion;
  if (datasetVersion !== undefined && (typeof datasetVersion !== "string" || datasetVersion.trim() === "")) {
    throw new Error("Invalid stored assessment report: snapshot datasetVersion is invalid");
  }
  if (Object.keys(source).some((key) => !["providerId", "providerVersion", "datasetVersion", "sourceKind"].includes(key))) {
    throw new Error("Invalid stored assessment report: snapshot source has an unknown field");
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256) || !/^[a-f0-9]{64}$/u.test(canonicalDigest)) {
    throw new Error("Invalid stored assessment report: snapshot digests must be SHA-256 values");
  }
  if (!Array.isArray(stored.identityEvidence) || !Array.isArray(stored.observations)) {
    throw new Error("Invalid stored assessment report: observations and identityEvidence must be arrays");
  }
  const identityEvidence = stored.identityEvidence.map(parseAssessmentIdentityEvidence);
  const observations = stored.observations.map(parseAssessmentObservation);
  const observationIds = new Set<string>();
  for (const observation of observations) {
    if (observationIds.has(observation.observationId)) throw new Error("Invalid stored assessment report: duplicate observationId");
    observationIds.add(observation.observationId);
    assertExactAssessmentSubject(observation.subject);
  }
  const evidenceIds = new Set<string>();
  const resolved = new Set<string>();
  for (const evidence of identityEvidence) {
    if (evidenceIds.has(evidence.evidenceId)) throw new Error("Invalid stored assessment report: duplicate evidenceId");
    evidenceIds.add(evidence.evidenceId);
    assertIdentityEvidence(evidence);
    if (evidence.status === "found" && evidence.matchedSubject) {
      resolved.add(`${evidence.matchedSubject.kind}\u0000${evidence.matchedSubject.canonicalId}`);
    }
  }
  for (const observation of observations) {
    if (!resolved.has(`${observation.subject.kind}\u0000${observation.subject.canonicalId}`)) {
      throw new Error(`Invalid stored assessment report: missing identity evidence for ${observation.subject.canonicalId}`);
    }
  }

  let policy: ValidatedAssessmentPolicy | null = null;
  if (stored.policy !== null) {
    const storedPolicy = requireRecord(stored.policy, "stored assessment policy");
    const { digest: storedDigest, ...definition } = storedPolicy;
    policy = validateAssessmentPolicy(definition);
    if (storedDigest !== policy.digest) throw new Error("Invalid stored assessment report: policy digest mismatch");
  }
  const recomputed = buildReport(
    {
      path,
      sha256,
      snapshotId,
      canonicalDigest,
      createdAt,
      source: {
        providerId,
        providerVersion,
        ...(typeof datasetVersion === "string" ? { datasetVersion } : {}),
        sourceKind: "user-snapshot",
      },
    },
    identityEvidence,
    observations,
    policy,
  );
  if (stored.resultDigest !== recomputed.resultDigest) {
    throw new Error("Invalid stored assessment report: result digest mismatch");
  }
  if (canonicalJson(stored.conflicts as JsonValue) !== canonicalJson(recomputed.conflicts as unknown as JsonValue)) {
    throw new Error("Invalid stored assessment report: conflict projection mismatch");
  }
  if (canonicalJson(stored.evaluation as JsonValue) !== canonicalJson(recomputed.evaluation as unknown as JsonValue)) {
    throw new Error("Invalid stored assessment report: policy trace mismatch");
  }
  return recomputed;
}

/** Offline replay reads the common run record and never touches the snapshot path. */
export async function replayAssessment(
  runId: string,
  store: AssessmentRunStore,
  options: { policy?: unknown | null } = {},
): Promise<AssessmentReport> {
  const stored = await store.readAssessmentRun(runId);
  if (stored.runId !== runId) throw new Error(`Assessment run id mismatch: expected ${runId}, got ${stored.runId}`);
  const payload = requireRecord(stored.payload, "stored assessment run payload");
  if (payload.schemaVersion !== 1 || payload.kind !== "assessment") {
    throw new Error(`Run ${runId} is not a supported assessment run`);
  }
  const report = validateStoredReport(payload.report);
  const request = requireRecord(payload.request, "stored assessment run request");
  const snapshot = requireRecord(request.snapshot, "stored assessment run snapshot request");
  const requestedPath = requireString(snapshot.path, "stored assessment run snapshot path");
  const requestedSha256 = requireString(snapshot.sha256, "stored assessment run snapshot checksum").toLowerCase();
  if (requestedPath !== report.snapshot.path || requestedSha256 !== report.snapshot.sha256) {
    throw new Error("Invalid stored assessment run: request snapshot does not match the persisted report");
  }
  const policyDigest = request.policyDigest;
  if (policyDigest !== (report.policy?.digest ?? null)) {
    throw new Error("Invalid stored assessment run: request policy digest does not match the persisted report");
  }
  if (options.policy === undefined) return report;
  const policy = options.policy === null ? null : validateAssessmentPolicy(options.policy);
  return buildReport(report.snapshot, report.identityEvidence, report.observations, policy);
}

export interface AssessmentFacade {
  plan(request: AssessmentRequest): Promise<AssessmentPlanResult>;
  run(request: AssessmentRequest): Promise<AssessmentExecutionResult>;
  replay(runId: string, options?: { policy?: unknown | null }): Promise<AssessmentReport>;
}

export function createAssessmentFacade(
  store: AssessmentRunStore,
): AssessmentFacade {
  return {
    plan: (request) => planAssessment(request),
    run: (request) => runAssessment(request, store),
    replay: (runId, replayOptions) => replayAssessment(runId, store, replayOptions),
  };
}
