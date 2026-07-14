import { canonicalJson, digestJson, type JsonValue } from "./canonical.js";
import type { AssessmentConflict, AssessmentObservation, AssessmentSignal } from "./types.js";

export function assessmentSignalKey(signal: AssessmentSignal): string {
  return canonicalJson(signal as unknown as JsonValue);
}

function comparisonTime(observation: AssessmentObservation): string {
  if (observation.signal.kind === "post_publication_event") {
    return observation.effectiveAt?.slice(0, 10) ?? "event-time-unspecified";
  }
  if (observation.signal.kind === "venue_metric" && observation.signal.metricYear !== undefined) {
    return `metric-year:${observation.signal.metricYear}`;
  }
  if (observation.signal.kind === "citation_count" && observation.signal.timeScope) {
    return `scope:${canonicalJson(observation.signal.timeScope as unknown as JsonValue)}`;
  }
  return `observed-day:${(observation.sourceTimestamp ?? observation.observedAt).slice(0, 10)}`;
}

export function assessmentComparisonKey(observation: AssessmentObservation): string {
  return `${observation.subject.kind}\u0000${observation.subject.canonicalId}\u0000${assessmentSignalKey(observation.signal)}\u0000${comparisonTime(observation)}`;
}

/**
 * Preserve every value and identify only comparable contradictions. Event rows
 * are append-only facts (multiple corrections can coexist), so they are never
 * collapsed into a value conflict.
 */
export function reduceAssessmentConflicts(observations: readonly AssessmentObservation[]): AssessmentConflict[] {
  const groups = new Map<string, AssessmentObservation[]>();
  for (const observation of observations) {
    if (observation.status !== "found" || observation.signal.kind === "post_publication_event") continue;
    const key = assessmentComparisonKey(observation);
    const existing = groups.get(key);
    if (existing) existing.push(observation);
    else groups.set(key, [observation]);
  }

  const conflicts: AssessmentConflict[] = [];
  for (const [comparisonKey, group] of [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const byValue = new Map<string, AssessmentObservation[]>();
    for (const observation of group) {
      const digest = digestJson(observation.value as JsonValue);
      const existing = byValue.get(digest);
      if (existing) existing.push(observation);
      else byValue.set(digest, [observation]);
    }
    if (byValue.size < 2) continue;
    const observationIds = group.map((entry) => entry.observationId).sort();
    const valueDigests = [...byValue.keys()].sort();
    const first = group[0];
    if (!first) continue;
    conflicts.push({
      conflictId: `conflict:${digestJson({ comparisonKey, observationIds, valueDigests })}`,
      subjectKey: `${first.subject.kind}:${first.subject.canonicalId}`,
      signalKey: assessmentSignalKey(first.signal),
      comparisonKey,
      observationIds,
      valueDigests,
      reason: "Comparable found observations report different source values; no provider was selected as a winner.",
    });
  }
  return conflicts;
}
