import type {
  PruneExclusionReason,
  ResearchRunRecord,
  RunPruneCandidate,
} from "./types.js";

export function assertMaxAgeDays(value: number): void {
  if (!Number.isInteger(value) || value === 0 || value < -1) {
    throw new Error("maxAgeDays must be -1 or a positive integer");
  }
}

export function pruneCutoff(now: Date, maxAgeDays: number): Date | null {
  assertMaxAgeDays(maxAgeDays);
  return maxAgeDays === -1
    ? null
    : new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1_000);
}

export function classifyPruneEligibility(
  record: ResearchRunRecord,
  bytes: number,
  now: Date,
  maxAgeDays: number,
): { candidate: RunPruneCandidate } | { excluded: PruneExclusionReason } {
  const cutoff = pruneCutoff(now, maxAgeDays);
  if (cutoff === null) return { excluded: "retention-disabled" };
  if (record.pinned) return { excluded: "pinned" };
  if (record.status === "running") return { excluded: "active" };
  if (
    record.checkpoint !== undefined &&
    (record.status === "interrupted" || record.status === "partial" || record.status === "failed")
  ) {
    return { excluded: "resumable" };
  }
  if (!record.finishedAt || Date.parse(record.finishedAt) >= cutoff.getTime()) {
    return { excluded: "not-old-enough" };
  }
  return {
    candidate: {
      runId: record.runId,
      finishedAt: record.finishedAt,
      ageDays: Math.floor((now.getTime() - Date.parse(record.finishedAt)) / (24 * 60 * 60 * 1_000)),
      bytes,
    },
  };
}
