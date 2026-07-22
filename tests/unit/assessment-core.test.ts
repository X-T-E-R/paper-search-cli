import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAssessmentSubject,
  createCommonAssessmentRunStoreAdapter,
  loadAssessmentSnapshot,
  planAssessment,
  reduceAssessmentConflicts,
  replayAssessment,
  runAssessment,
  sha256Bytes,
  validateAssessmentPolicy,
  evaluateAssessmentPolicy,
  type AssessmentObservation,
  type AssessmentPolicy,
  type AssessmentRunStore,
  type AssessmentRunStoreStart,
  type AssessmentSnapshot,
} from "../../src/assessment/index.js";
import { ResearchRunStore } from "../../src/runs/store.js";

const observedAt = "2026-07-15T10:00:00.000Z";
const work = createAssessmentSubject("work", { doi: "10.1000/example" }, "doi");

function source(providerId: string) {
  return {
    providerId,
    providerVersion: "1.2.3",
    sourceKind: "user-snapshot" as const,
    datasetVersion: "2026-07-15",
  };
}

function observation(
  observationId: string,
  overrides: Partial<AssessmentObservation> = {},
): AssessmentObservation {
  return {
    observationId,
    subject: work,
    signal: {
      kind: "citation_count",
      metricDefinition: "provider work citation total",
      timeScope: { label: "snapshot-2026-07-15" },
    },
    status: "found",
    value: 12,
    observedAt,
    source: source("snapshot-a"),
    rawEvidenceDigest: "a".repeat(64),
    ...overrides,
  } as unknown as AssessmentObservation;
}

function snapshot(observations: AssessmentObservation[]): AssessmentSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "offline-2026-07-15",
    createdAt: observedAt,
    source: {
      providerId: "local-snapshot",
      providerVersion: "1",
      datasetVersion: "2026-07-15",
      sourceKind: "user-snapshot",
    },
    identityEvidence: [
      {
        evidenceId: "identity-1",
        status: "found",
        inputIdentifiers: { doi: "10.1000/example" },
        matchedSubject: work,
        matchedIdentifiers: { doi: "10.1000/example" },
        matchMethod: "exact_identifier",
        observedAt,
        source: source("snapshot-a"),
      },
    ],
    observations,
  };
}

async function writeSnapshot(value: AssessmentSnapshot): Promise<{ path: string; sha256: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-assessment-"));
  const file = path.join(root, "snapshot.json");
  const bytes = JSON.stringify(value, null, 2);
  await writeFile(file, bytes, "utf8");
  return { path: file, sha256: sha256Bytes(bytes) };
}

describe("assessment observations and immutable snapshots", () => {
  it("loads a checksum-addressed snapshot and retains every coverage outcome and time authority", async () => {
    const observations: AssessmentObservation[] = [
      observation("found", { sourceTimestamp: "2026-07-14T00:00:00.000Z" }),
      observation("not-found", {
        signal: { kind: "access", field: "open_access_status" },
        status: "not_found",
        value: undefined,
      }),
      observation("unavailable", {
        signal: { kind: "bibliographic_lifecycle", field: "version_of_record" },
        status: "unavailable",
        value: undefined,
        diagnostics: { code: "missing_configuration", message: "Provider is not configured" },
      }),
      observation("error", {
        signal: { kind: "venue_metric", metricName: "h-index", metricDefinition: "dataset h-index" },
        status: "error",
        value: undefined,
        diagnostics: { code: "snapshot_row_error", message: "Source row was malformed" },
      }),
      observation("ambiguous", {
        signal: { kind: "identity_resolution" },
        status: "ambiguous",
        value: undefined,
      }),
    ];
    const ref = await writeSnapshot(snapshot(observations));
    const loaded = await loadAssessmentSnapshot(ref);

    expect(loaded.ref).toEqual({ path: path.resolve(ref.path), sha256: ref.sha256 });
    expect(loaded.snapshot.observations.map((entry) => entry.status)).toEqual([
      "found",
      "not_found",
      "unavailable",
      "error",
      "ambiguous",
    ]);
    expect(loaded.snapshot.observations[0]).toMatchObject({
      observedAt,
      sourceTimestamp: "2026-07-14T00:00:00.000Z",
      source: { providerId: "snapshot-a", providerVersion: "1.2.3", datasetVersion: "2026-07-15" },
    });
    expect(Object.isFrozen(loaded.snapshot.observations[0])).toBe(true);
  });

  it("fails closed on checksum changes, unproven identities, and invalid negative findings", async () => {
    const ref = await writeSnapshot(snapshot([observation("citation")]));
    await expect(loadAssessmentSnapshot({ ...ref, sha256: "0".repeat(64) })).rejects.toThrow(/checksum mismatch/);

    const unproven = snapshot([observation("citation")]);
    unproven.identityEvidence = [];
    await expect(loadAssessmentSnapshot(await writeSnapshot(unproven))).rejects.toThrow(/no found identity evidence/);

    const falseNegative = snapshot([
      observation("negative", { status: "not_found", value: 0 } as unknown as Partial<AssessmentObservation>),
    ]);
    await expect(loadAssessmentSnapshot(await writeSnapshot(falseNegative))).rejects.toThrow(/must not claim a value/);

    const secretBearing = snapshot([
      observation("secret-bearing", { caveats: ["authorization=private-value"] }),
    ]);
    await expect(loadAssessmentSnapshot(await writeSnapshot(secretBearing))).rejects.toThrow(/cannot enter a durable run/);
  });
});

describe("assessment conflicts and policy trace", () => {
  it("preserves comparable source conflicts without last-writer-wins or merging distinct events", () => {
    const observations = [
      observation("count-a", { value: 11, source: source("snapshot-a") }),
      observation("count-b", { value: 13, source: source("snapshot-b") }),
      observation("count-history-a", {
        value: 8,
        signal: {
          kind: "citation_count",
          metricDefinition: "provider work citation total",
          timeScope: { label: "snapshot-2026-07-13" },
        },
        sourceTimestamp: "2026-07-13T00:00:00.000Z",
      }),
      observation("count-history-b", {
        value: 9,
        signal: {
          kind: "citation_count",
          metricDefinition: "provider work citation total",
          timeScope: { label: "snapshot-2026-07-14" },
        },
        sourceTimestamp: "2026-07-14T00:00:00.000Z",
      }),
      observation("correction", {
        signal: { kind: "post_publication_event", eventType: "correction" },
        value: { noticeId: "doi:10.1000/correction" },
        effectiveAt: "2025-02-01T00:00:00.000Z",
      }),
      observation("retraction", {
        signal: { kind: "post_publication_event", eventType: "retraction" },
        value: { noticeId: "doi:10.1000/retraction" },
        effectiveAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const conflicts = reduceAssessmentConflicts(observations);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.observationIds).toEqual(["count-a", "count-b"]);
    expect(conflicts[0]?.reason).toContain("no provider was selected as a winner");
    expect(observations.map((entry) => entry.value)).toEqual([
      11,
      13,
      8,
      9,
      { noticeId: "doi:10.1000/correction" },
      { noticeId: "doi:10.1000/retraction" },
    ]);
  });

  it("routes required conflict and missing evidence to review with exact ids", () => {
    const observations = [
      observation("count-a", { value: 11, source: source("snapshot-a") }),
      observation("count-b", { value: 13, source: source("snapshot-b") }),
    ];
    const conflicts = reduceAssessmentConflicts(observations);
    const conflictPolicy = validateAssessmentPolicy({
      schemaVersion: 1,
      name: "systematic-review",
      version: "1",
      rules: [
        {
          id: "citation-threshold",
          all: [
            {
              signal: {
                kind: "citation_count",
                metricDefinition: "provider work citation total",
                timeScope: { label: "snapshot-2026-07-15" },
              },
              operator: "greater_than_or_equal",
              value: 10,
              required: true,
            },
          ],
          action: "include",
        },
      ],
    });
    const conflictResult = evaluateAssessmentPolicy(conflictPolicy, observations, conflicts);
    expect(conflictResult).toMatchObject({
      disposition: "review",
      decidedByRuleId: "citation-threshold",
      observationIds: ["count-a", "count-b"],
      trace: [{ ruleId: "citation-threshold", outcome: "review_conflict" }],
    });
    expect(conflictResult.conflictIds).toEqual([conflicts[0]?.conflictId]);

    const missingPolicy = validateAssessmentPolicy({
      schemaVersion: 1,
      name: "oa-required",
      version: "1",
      rules: [
        {
          id: "require-oa",
          all: [
            {
              signal: { kind: "access", field: "open_access_status" },
              operator: "equals",
              value: "open",
              required: true,
            },
          ],
          action: "include",
        },
      ],
    });
    expect(evaluateAssessmentPolicy(missingPolicy, observations, conflicts)).toMatchObject({
      disposition: "review",
      decidedByRuleId: "require-oa",
      trace: [{ outcome: "review_missing", conditions: [{ outcome: "missing", observationIds: [] }] }],
    });
  });

  it("lets a named rule distinguish retraction from correction without producing a score", () => {
    const observations = [
      observation("correction", {
        signal: { kind: "post_publication_event", eventType: "correction" },
        value: { noticeId: "doi:10.1000/correction" },
      }),
    ];
    const policy: AssessmentPolicy = {
      schemaVersion: 1,
      name: "integrity-events",
      version: "1",
      rules: [
        {
          id: "exclude-retraction",
          all: [
            {
              signal: { kind: "post_publication_event", eventType: "retraction" },
              operator: "exists",
            },
          ],
          action: "exclude",
        },
        {
          id: "review-correction",
          all: [
            {
              signal: { kind: "post_publication_event", eventType: "correction" },
              operator: "exists",
            },
          ],
          action: "review",
        },
      ],
    };
    const result = evaluateAssessmentPolicy(validateAssessmentPolicy(policy), observations, []);
    expect(result).toMatchObject({ disposition: "review", decidedByRuleId: "review-correction" });
    expect(result.observationIds).toEqual(["correction"]);
    expect(JSON.stringify(result)).not.toMatch(/score|quality|misconduct|legal verdict/iu);
  });
});

describe("command-neutral assessment execution", () => {
  it("keeps plan write-free and creates exactly one common run on execution", async () => {
    const ref = await writeSnapshot(snapshot([observation("citation")]));
    let storedPayload: unknown;
    const startAssessmentRun = vi.fn(async (_input: AssessmentRunStoreStart) => {
      return { runId: "assessment-run-1", createdAt: observedAt };
    });
    const completeAssessmentRun = vi.fn(async (_runId: string, payload: unknown) => {
      storedPayload = payload;
      return { terminalAt: observedAt };
    });
    const store: AssessmentRunStore = {
      startAssessmentRun,
      completeAssessmentRun,
      failAssessmentRun: vi.fn(async () => ({ terminalAt: observedAt })),
      readAssessmentRun: vi.fn(async () => ({ runId: "assessment-run-1", payload: storedPayload })),
    };

    const plan = await planAssessment({ snapshot: ref });
    expect(plan).toMatchObject({ planned: true, runId: null, report: { evaluation: null, policy: null } });
    expect(startAssessmentRun).not.toHaveBeenCalled();
    expect("disposition" in plan.report).toBe(false);

    const run = await runAssessment({ snapshot: ref }, store);
    expect(run).toMatchObject({ planned: false, runId: "assessment-run-1", createdAt: observedAt });
    expect(startAssessmentRun).toHaveBeenCalledTimes(1);
    expect(startAssessmentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "assessment_run",
        request: expect.objectContaining({ snapshot: { path: ref.path, sha256: ref.sha256 }, policyDigest: null }),
      }),
    );
    expect(completeAssessmentRun).toHaveBeenCalledTimes(1);
    expect(completeAssessmentRun).toHaveBeenCalledWith(
      "assessment-run-1",
      expect.objectContaining({ kind: "assessment", schemaVersion: 1 }),
    );

    const replayed = await replayAssessment("assessment-run-1", store);
    expect(replayed.resultDigest).toBe(run.report.resultDigest);
    expect(replayed.observations).toEqual(run.report.observations);

    const corrupt = structuredClone(storedPayload) as {
      report: { resultDigest: string };
    };
    corrupt.report.resultDigest = "0".repeat(64);
    const corruptStore: AssessmentRunStore = {
      startAssessmentRun,
      completeAssessmentRun,
      failAssessmentRun: vi.fn(async () => ({ terminalAt: observedAt })),
      readAssessmentRun: async () => ({ runId: "assessment-run-1", payload: corrupt }),
    };
    await expect(replayAssessment("assessment-run-1", corruptStore)).rejects.toThrow(/result digest mismatch/);
  });

  it("maps assessment execution and offline replay onto one concrete common run record", async () => {
    const ref = await writeSnapshot(snapshot([observation("citation")]));
    const runRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-assessment-runs-"));
    const common = await ResearchRunStore.open({
      root: runRoot,
      maxAgeDays: -1,
      now: () => new Date(observedAt),
      randomUuid: () => "00000000-0000-4000-8000-000000000001",
    });
    const adapter = createCommonAssessmentRunStoreAdapter(common, { cliVersion: "test" });

    const executed = await runAssessment({ snapshot: ref }, adapter);
    const commonRecord = await common.read(executed.runId);
    expect(commonRecord).toMatchObject({
      kind: "assessment",
      status: "completed",
      finishedAt: observedAt,
      request: { tool: "assessment_run", assessment: { policyDigest: null } },
      result: { schemaVersion: 1, kind: "assessment" },
    });
    expect(await replayAssessment(executed.runId, adapter)).toEqual(executed.report);

    const replayedWithPolicy = await replayAssessment(executed.runId, adapter, {
      policy: {
        schemaVersion: 1,
        name: "offline-replay-policy",
        version: "1",
        rules: [
          {
            id: "citation-evidence",
            all: [
              {
                signal: {
                  kind: "citation_count",
                  metricDefinition: "provider work citation total",
                  timeScope: { label: "snapshot-2026-07-15" },
                },
                operator: "greater_than_or_equal",
                value: 10,
                required: true,
              },
            ],
            action: "include",
          },
        ],
      },
    });
    expect(replayedWithPolicy.evaluation).toMatchObject({
      disposition: "include",
      decidedByRuleId: "citation-evidence",
      observationIds: ["citation"],
    });
    expect(await common.list({ kind: "assessment" })).toHaveLength(1);
  });

  it("leaves one terminal failed common run when execution cannot validate its bound snapshot", async () => {
    const ref = await writeSnapshot(snapshot([observation("citation")]));
    const runRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-assessment-failed-runs-"));
    const common = await ResearchRunStore.open({ root: runRoot, maxAgeDays: -1 });
    const adapter = createCommonAssessmentRunStoreAdapter(common, { cliVersion: "test" });

    await expect(
      runAssessment({ snapshot: { ...ref, sha256: "0".repeat(64) } }, adapter),
    ).rejects.toThrow(/checksum mismatch/);
    const records = await common.list({ kind: "assessment" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "assessment", status: "failed" });
  });
});
