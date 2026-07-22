import type {
  ResearchRunRecord,
  ResearchRunStatus,
  TerminalRunStatus,
} from "../runs/types.js";
import { normalizeCitationRequest } from "./identifiers.js";
import { planCitationExpansion } from "./planner.js";
import {
  createInitialCitationCheckpoint,
  executeCitationTraversal,
} from "./traversal.js";
import type {
  CitationAttempt,
  CitationCheckpoint,
  CitationExpandRequest,
  CitationPlan,
  CitationProviderSnapshot,
  CitationRunResult,
  CitationServiceDependencies,
  NormalizedCitationRequest,
} from "./types.js";
import { CitationServiceError } from "./types.js";

function requireRunId(request: CitationExpandRequest): string {
  const runId = request.runId?.trim();
  if (!runId) throw new CitationServiceError("run_id_required", "runId is required for run/resume");
  return runId;
}

function isCheckpoint(value: unknown): value is CitationCheckpoint {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CitationCheckpoint>;
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const isWork = (candidate: unknown): boolean => {
    if (!isObject(candidate)) return false;
    return (
      Number.isInteger(candidate.depth) &&
      typeof candidate.nodeKey === "string" &&
      (candidate.direction === "backward" || candidate.direction === "forward") &&
      typeof candidate.providerId === "string" &&
      (candidate.cursor === undefined || typeof candidate.cursor === "string") &&
      Number.isInteger(candidate.fetchedRelations)
    );
  };
  return (
    entry.schemaVersion === 1 &&
    Array.isArray(entry.nodes) &&
    entry.nodes.every(
      (node) =>
        isObject(node) &&
        typeof node.key === "string" &&
        isObject(node.identifiers) &&
        isObject(node.providerNativeIds) &&
        Object.values(node.providerNativeIds).every((nativeId) => typeof nativeId === "string") &&
        isObject(node.item) &&
        typeof node.item.title === "string" &&
        Number.isInteger(node.depthDiscovered),
    ) &&
    Array.isArray(entry.edges) &&
    entry.edges.every(
      (edge) =>
        isObject(edge) &&
        typeof edge.id === "string" &&
        typeof edge.citingKey === "string" &&
        typeof edge.citedKey === "string" &&
        edge.relation === "cites" &&
        Array.isArray(edge.provenance),
    ) &&
    !!entry.keyAliases &&
    typeof entry.keyAliases === "object" &&
    Object.values(entry.keyAliases).every((target) => typeof target === "string") &&
    Array.isArray(entry.pending) && entry.pending.every(isWork) &&
    Array.isArray(entry.completed) && entry.completed.every(isWork) &&
    typeof entry.providerPages === "number" && Number.isInteger(entry.providerPages) && entry.providerPages >= 0 &&
    typeof entry.successfulPages === "number" && Number.isInteger(entry.successfulPages) && entry.successfulPages >= 0 &&
    Array.isArray(entry.capStops) && entry.capStops.every(isObject)
  );
}

function isNormalizedRequest(value: unknown): value is NormalizedCitationRequest {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<NormalizedCitationRequest>;
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  return (
    Array.isArray(entry.seeds) && entry.seeds.length > 0 &&
    entry.seeds.every(
      (seed) =>
        isObject(seed) &&
        isObject(seed.identifiers) &&
        isObject(seed.item) &&
        typeof seed.item.title === "string",
    ) &&
    Array.isArray(entry.directions) && entry.directions.length > 0 &&
    entry.directions.every((direction) => direction === "backward" || direction === "forward") &&
    Array.isArray(entry.excludeIdentifiers) &&
    entry.excludeIdentifiers.every(isObject) &&
    (entry.requestedProviders === undefined ||
      (Array.isArray(entry.requestedProviders) &&
        entry.requestedProviders.every((providerId) => typeof providerId === "string"))) &&
    !!entry.limits &&
    isObject(entry.limits) &&
    (["depth", "perNode", "nodes", "edges", "providerPages", "concurrency"] as const).every(
      (key) => Number.isInteger(entry.limits?.[key]),
    )
  );
}

function isProviderSnapshots(value: unknown): value is CitationProviderSnapshot[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const snapshot = entry as Partial<CitationProviderSnapshot>;
      return (
        typeof snapshot.providerId === "string" &&
        typeof snapshot.providerVersion === "string" &&
        !!snapshot.citationGraph &&
        Array.isArray(snapshot.citationGraph.directions) &&
        snapshot.citationGraph.directions.length > 0 &&
        snapshot.citationGraph.directions.every(
          (direction) => direction === "backward" || direction === "forward",
        ) &&
        Array.isArray(snapshot.citationGraph.targetIdentifierKinds) &&
        snapshot.citationGraph.targetIdentifierKinds.length > 0 &&
        typeof snapshot.citationGraph.maxPageSize === "number" &&
        Number.isInteger(snapshot.citationGraph.maxPageSize)
      );
    })
  );
}

function normalizeNewRequest(request: CitationExpandRequest): NormalizedCitationRequest {
  return normalizeCitationRequest({
    seeds: request.seeds ?? [],
    directions: request.directions,
    providers: request.providers,
    excludeIdentifiers: request.excludeIdentifiers,
    limits: request.limits,
  });
}

function providerSnapshotKey(snapshot: CitationProviderSnapshot): string {
  return JSON.stringify([
    snapshot.providerId,
    snapshot.providerVersion,
    snapshot.citationGraph.directions,
    snapshot.citationGraph.targetIdentifierKinds,
    snapshot.citationGraph.maxPageSize,
  ]);
}

function assertProviderSnapshotsCurrent(
  snapshots: readonly CitationProviderSnapshot[],
  dependencies: CitationServiceDependencies,
): void {
  const current = new Map(dependencies.providers.map((provider) => [provider.id, provider]));
  for (const snapshot of snapshots) {
    const provider = current.get(snapshot.providerId);
    if (!provider?.capability) {
      throw new CitationServiceError(
        "provider_drift",
        `Citation provider is missing on resume: ${snapshot.providerId}`,
      );
    }
    const currentSnapshot: CitationProviderSnapshot = {
      providerId: provider.id,
      providerVersion: provider.version,
      citationGraph: provider.capability,
    };
    if (providerSnapshotKey(snapshot) !== providerSnapshotKey(currentSnapshot)) {
      throw new CitationServiceError(
        "provider_drift",
        `Citation provider version or capability changed: ${snapshot.providerId}`,
      );
    }
  }
}

function terminalStatus(
  checkpoint: CitationCheckpoint,
  attempts: readonly CitationAttempt[],
): TerminalRunStatus {
  const failedAttempts = attempts.filter((attempt) => attempt.outcome === "error").length;
  if (checkpoint.successfulPages === 0 && checkpoint.pending.length > 0 && failedAttempts > 0) {
    return "failed";
  }
  if (checkpoint.pending.length > 0 || checkpoint.capStops.length > 0) {
    return "partial";
  }
  return "completed";
}

function storedAttempts(record: ResearchRunRecord): CitationAttempt[] {
  return record.attempts.filter(
    (value): value is CitationAttempt =>
      !!value &&
      typeof value === "object" &&
      ((value as CitationAttempt).outcome === "success" ||
        (value as CitationAttempt).outcome === "error"),
  );
}

function buildResult(
  mode: "run" | "resume",
  record: ResearchRunRecord,
  checkpoint: CitationCheckpoint,
  status: ResearchRunStatus,
): CitationRunResult {
  return {
    mode,
    runId: record.runId,
    status,
    nodes: checkpoint.nodes,
    edges: checkpoint.edges,
    attempts: storedAttempts(record),
    diagnostics: record.diagnostics.filter(
      (value): value is { code: string; message: string } =>
        !!value &&
        typeof value === "object" &&
        typeof (value as { code?: unknown }).code === "string" &&
        typeof (value as { message?: unknown }).message === "string",
    ),
    capStops: checkpoint.capStops,
    pendingWorkUnits: checkpoint.pending.length,
  };
}

async function executeRun(
  mode: "run" | "resume",
  record: ResearchRunRecord,
  request: NormalizedCitationRequest,
  snapshots: CitationProviderSnapshot[],
  checkpoint: CitationCheckpoint,
  dependencies: CitationServiceDependencies,
): Promise<CitationRunResult> {
  let currentRecord = record;
  await executeCitationTraversal({
    request,
    selectedProviders: snapshots,
    providers: dependencies.providers,
    checkpoint,
    now: dependencies.now ?? (() => new Date()),
    async onProgress(progress) {
      currentRecord = await dependencies.runs.updateProgress(currentRecord.runId, {
        checkpoint: progress.checkpoint,
        appendAttempts: [progress.attempt],
        appendDiagnostics: progress.diagnostic ? [progress.diagnostic] : undefined,
      });
    },
  });
  const attempts = storedAttempts(currentRecord);
  const status = terminalStatus(checkpoint, attempts);
  const result = buildResult(mode, currentRecord, checkpoint, status);
  currentRecord = await dependencies.runs.finish(currentRecord.runId, {
    status,
    checkpoint,
    result,
  });
  return buildResult(mode, currentRecord, checkpoint, status);
}

export function createCitationService(dependencies: CitationServiceDependencies): {
  expand(request: CitationExpandRequest): Promise<CitationPlan | CitationRunResult>;
  status(runId: string): Promise<CitationRunResult>;
} {
  return {
    async expand(request) {
      const mode = request.mode ?? "plan";
      if (mode === "resume") {
        const runId = requireRunId(request);
        if (
          request.seeds !== undefined ||
          request.directions !== undefined ||
          request.providers !== undefined ||
          request.excludeIdentifiers !== undefined ||
          request.limits !== undefined
        ) {
          throw new CitationServiceError(
            "invalid_request",
            "resume uses the immutable stored request and accepts only runId",
          );
        }
        let record: ResearchRunRecord;
        try {
          record = await dependencies.runs.read(runId);
        } catch (error) {
          throw new CitationServiceError(
            "run_not_found",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (
          record.kind !== "citation" ||
          !isNormalizedRequest(record.request) ||
          !isProviderSnapshots(record.resolvedSelection) ||
          !isCheckpoint(record.checkpoint)
        ) {
          throw new CitationServiceError("invalid_checkpoint", `Run ${runId} is not a valid citation checkpoint`);
        }
        if (record.status === "completed" || record.status === "running") {
          throw new CitationServiceError(
            "invalid_request",
            `Citation run ${runId} is not resumable from status ${record.status}`,
          );
        }
        const storedRequest = record.request;
        const storedSelection = record.resolvedSelection;
        const storedCheckpoint = record.checkpoint;
        assertProviderSnapshotsCurrent(storedSelection, dependencies);
        record = await dependencies.runs.resume(runId);
        return executeRun(
          "resume",
          record,
          storedRequest,
          storedSelection,
          storedCheckpoint,
          dependencies,
        );
      }

      const normalized = normalizeNewRequest(request);
      const plan = planCitationExpansion(normalized, dependencies.providers);
      if (mode === "plan") return plan;
      if (mode !== "run") {
        throw new CitationServiceError("invalid_request", `Unsupported citation mode: ${String(mode)}`);
      }
      const runId = requireRunId(request);
      if (plan.selectedProviders.length === 0 || (normalized.limits.depth > 0 && plan.plannedWorkUnits === 0)) {
        throw new CitationServiceError(
          "no_capable_provider",
          "No selected, available citation provider can target the requested exact seed identifiers",
        );
      }
      const checkpoint = createInitialCitationCheckpoint(normalized, plan.selectedProviders);
      let record = await dependencies.runs.create({
        runId,
        kind: "citation",
        request: normalized,
        resolvedSelection: plan.selectedProviders,
        build: dependencies.build,
      });
      // Establish resumable state before the first provider/network page.
      record = await dependencies.runs.updateProgress(record.runId, {
        checkpoint,
        appendDiagnostics: plan.warnings.map((message) => ({
          code: "provider_selection_warning",
          message,
        })),
      });
      return executeRun(
        "run",
        record,
        normalized,
        plan.selectedProviders,
        checkpoint,
        dependencies,
      );
    },

    async status(runId) {
      const record = await dependencies.runs.read(runId);
      if (record.kind !== "citation" || !isCheckpoint(record.checkpoint)) {
        throw new CitationServiceError("invalid_checkpoint", `Run ${runId} is not a citation run`);
      }
      return buildResult("resume", record, record.checkpoint, record.status);
    },
  };
}
