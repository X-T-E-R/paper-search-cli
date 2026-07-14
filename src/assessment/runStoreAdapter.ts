import { canonicalJson, type JsonValue } from "./canonical.js";
import type {
  AssessmentRunStore,
  AssessmentRunStoreStart,
  AssessmentRunStoreStarted,
} from "./service.js";
import type { AssessmentRunPayload } from "./types.js";
import type { ResearchRunStore } from "../runs/store.js";
import type { RunBuildIdentity } from "../runs/types.js";

type CommonRunStorePort = Pick<ResearchRunStore, "create" | "read" | "finish">;

function assessmentRequestFromCommon(value: unknown): AssessmentRunPayload["request"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Common assessment run request is corrupt");
  }
  const assessment = (value as { assessment?: unknown }).assessment;
  if (typeof assessment !== "object" || assessment === null || Array.isArray(assessment)) {
    throw new Error("Common assessment run request has no assessment payload");
  }
  return assessment as AssessmentRunPayload["request"];
}

/** Maps the assessment lifecycle onto one create/finish record in ResearchRunStore. */
export class CommonAssessmentRunStoreAdapter implements AssessmentRunStore {
  constructor(
    private readonly store: CommonRunStorePort,
    private readonly build: RunBuildIdentity,
  ) {}

  async startAssessmentRun(input: AssessmentRunStoreStart): Promise<AssessmentRunStoreStarted> {
    const record = await this.store.create({
      kind: "assessment",
      request: { tool: input.tool, assessment: input.request },
      resolvedSelection: {
        snapshotSha256: input.request.snapshot.sha256,
        policyDigest: input.request.policyDigest,
      },
      build: this.build,
      provenance: [
        {
          kind: "assessment_snapshot",
          snapshot: input.request.snapshot,
          policyDigest: input.request.policyDigest,
        },
      ],
    });
    return { runId: record.runId, createdAt: record.startedAt };
  }

  async completeAssessmentRun(runId: string, payload: AssessmentRunPayload): Promise<{ terminalAt: string }> {
    const current = await this.store.read(runId);
    if (current.kind !== "assessment" || current.status !== "running") {
      throw new Error(`Common run ${runId} is not a running assessment run`);
    }
    const originalRequest = assessmentRequestFromCommon(current.request);
    if (
      canonicalJson(originalRequest as unknown as JsonValue) !==
      canonicalJson(payload.request as unknown as JsonValue)
    ) {
      throw new Error(`Assessment payload request drifted after common run ${runId} was created`);
    }
    const finished = await this.store.finish(runId, {
      status: "completed",
      result: payload,
      appendProvenance: [
        {
          kind: "assessment_result",
          snapshotSha256: payload.report.snapshot.sha256,
          snapshotSource: payload.report.snapshot.source,
          resultDigest: payload.report.resultDigest,
          policyDigest: payload.report.policy?.digest ?? null,
          observationCount: payload.report.observations.length,
          conflictCount: payload.report.conflicts.length,
        },
      ],
    });
    if (!finished.finishedAt) throw new Error(`Common assessment run ${runId} has no terminal timestamp`);
    return { terminalAt: finished.finishedAt };
  }

  async failAssessmentRun(runId: string, error: unknown): Promise<{ terminalAt: string }> {
    const finished = await this.store.finish(runId, {
      status: "failed",
      appendDiagnostics: [
        {
          code: "assessment_execution_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    });
    if (!finished.finishedAt) throw new Error(`Failed common assessment run ${runId} has no terminal timestamp`);
    return { terminalAt: finished.finishedAt };
  }

  async readAssessmentRun(runId: string): Promise<{ runId: string; payload: unknown }> {
    const record = await this.store.read(runId);
    if (record.kind !== "assessment") throw new Error(`Run ${runId} is not an assessment run`);
    if (record.status !== "completed" || record.result === undefined) {
      throw new Error(`Assessment run ${runId} has no completed replay payload`);
    }
    return { runId: record.runId, payload: record.result };
  }
}

export function createCommonAssessmentRunStoreAdapter(
  store: CommonRunStorePort,
  build: RunBuildIdentity,
): AssessmentRunStore {
  return new CommonAssessmentRunStoreAdapter(store, build);
}
