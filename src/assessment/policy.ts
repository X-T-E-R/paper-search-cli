import { canonicalJson, digestJson, type JsonValue } from "./canonical.js";
import { assessmentSignalKey } from "./conflicts.js";
import { assertAssessmentPersistenceCanonical } from "./persistence.js";
import type {
  AssessmentConflict,
  AssessmentObservation,
  AssessmentPolicy,
  AssessmentPolicyCondition,
  AssessmentPolicyConditionTrace,
  AssessmentPolicyEvaluation,
  AssessmentPolicyRuleTrace,
} from "./types.js";
import { parseAssessmentPolicy } from "./validation.js";

export interface ValidatedAssessmentPolicy {
  policy: AssessmentPolicy;
  digest: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateAssessmentPolicy(value: unknown): ValidatedAssessmentPolicy {
  const policy = deepFreeze(parseAssessmentPolicy(value));
  assertAssessmentPersistenceCanonical(policy as unknown as JsonValue, "Assessment policy");
  return { policy, digest: digestJson(policy as unknown as JsonValue) };
}

function valuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);
}

function containsValue(container: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  if (typeof container === "string" && typeof expected === "string") return container.includes(expected);
  if (Array.isArray(container) && expected !== undefined) {
    return container.some((entry) => valuesEqual(entry, expected));
  }
  if (typeof container === "object" && container !== null && !Array.isArray(container) && typeof expected === "string") {
    return Object.hasOwn(container, expected);
  }
  return false;
}

function conditionMatchesValue(condition: AssessmentPolicyCondition, observation: AssessmentObservation): boolean {
  if (condition.operator === "exists") return true;
  const actual = observation.value;
  const expected = condition.value;
  switch (condition.operator) {
    case "equals":
      return valuesEqual(actual as unknown as JsonValue | undefined, expected);
    case "not_equals":
      return actual !== undefined && expected !== undefined && !valuesEqual(actual as unknown as JsonValue, expected);
    case "greater_than":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "greater_than_or_equal":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_than":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "less_than_or_equal":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains":
      return containsValue(actual as unknown as JsonValue | undefined, expected);
  }
}

function evaluateCondition(
  condition: AssessmentPolicyCondition,
  conditionIndex: number,
  observations: readonly AssessmentObservation[],
  conflicts: readonly AssessmentConflict[],
): AssessmentPolicyConditionTrace {
  const signalKey = assessmentSignalKey(condition.signal);
  const signalRelevant = observations.filter(
    (observation) =>
      assessmentSignalKey(observation.signal) === signalKey &&
      (condition.subjectKind === undefined || observation.subject.kind === condition.subjectKind) &&
      (condition.subjectCanonicalId === undefined || observation.subject.canonicalId === condition.subjectCanonicalId),
  );
  const relevant = signalRelevant.filter(
    (observation) => condition.providers === undefined || condition.providers.includes(observation.source.providerId),
  );
  const relevantIds = new Set(signalRelevant.map((observation) => observation.observationId));
  const relevantConflicts = conflicts.filter((conflict) =>
    conflict.observationIds.some((observationId) => relevantIds.has(observationId)),
  );
  if (relevantConflicts.length > 0) {
    const conflictObservationIds = uniqueSorted(
      relevantConflicts.flatMap((conflict) => conflict.observationIds),
    );
    return {
      conditionIndex,
      outcome: "conflict",
      observationIds: conflictObservationIds,
      conflictIds: relevantConflicts.map((entry) => entry.conflictId).sort(),
      detail: "Required evidence has unresolved comparable source conflicts.",
    };
  }
  const statuses = condition.statuses ?? ["found"];
  const candidates = relevant.filter((observation) => statuses.includes(observation.status));
  if (candidates.length === 0) {
    return {
      conditionIndex,
      outcome: condition.required === true ? "missing" : "not_matched",
      observationIds: relevant.map((entry) => entry.observationId).sort(),
      conflictIds: [],
      detail:
        condition.required === true
          ? "Required evidence is missing for the exact signal and source selector."
          : "No observation matched the signal, source, and status selector.",
    };
  }
  const matched = candidates.filter((observation) => conditionMatchesValue(condition, observation));
  return {
    conditionIndex,
    outcome: matched.length > 0 ? "matched" : "not_matched",
    observationIds: (matched.length > 0 ? matched : candidates).map((entry) => entry.observationId).sort(),
    conflictIds: relevantConflicts.map((entry) => entry.conflictId).sort(),
    detail:
      matched.length > 0
        ? `Condition ${condition.operator} matched ${matched.length} observation(s).`
        : `Evidence was present, but condition ${condition.operator} did not match.`,
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function evaluateAssessmentPolicy(
  validated: ValidatedAssessmentPolicy,
  observations: readonly AssessmentObservation[],
  conflicts: readonly AssessmentConflict[],
): AssessmentPolicyEvaluation {
  const trace: AssessmentPolicyRuleTrace[] = [];
  for (const rule of validated.policy.rules) {
    const conditions = rule.all.map((condition, index) =>
      evaluateCondition(condition, index, observations, conflicts),
    );
    const observationIds = uniqueSorted(conditions.flatMap((condition) => condition.observationIds));
    const conflictIds = uniqueSorted(conditions.flatMap((condition) => condition.conflictIds));
    const conflict = conditions.some((condition) => condition.outcome === "conflict");
    const missing = conditions.some((condition) => condition.outcome === "missing");
    const matched = conditions.every((condition) => condition.outcome === "matched");
    const ruleTrace: AssessmentPolicyRuleTrace = {
      ruleId: rule.id,
      outcome: conflict
        ? "review_conflict"
        : missing
          ? "review_missing"
          : matched
            ? "matched"
            : "not_matched",
      observationIds,
      conflictIds,
      conditions,
    };
    trace.push(ruleTrace);
    if (conflict || missing) {
      return {
        disposition: "review",
        policy: { name: validated.policy.name, version: validated.policy.version, digest: validated.digest },
        decidedByRuleId: rule.id,
        observationIds,
        conflictIds,
        trace,
      };
    }
    if (matched) {
      return {
        disposition: rule.action,
        policy: { name: validated.policy.name, version: validated.policy.version, digest: validated.digest },
        decidedByRuleId: rule.id,
        observationIds,
        conflictIds,
        trace,
      };
    }
  }
  return {
    disposition: "review",
    policy: { name: validated.policy.name, version: validated.policy.version, digest: validated.digest },
    decidedByRuleId: null,
    observationIds: uniqueSorted(trace.flatMap((rule) => rule.observationIds)),
    conflictIds: uniqueSorted(trace.flatMap((rule) => rule.conflictIds)),
    trace,
  };
}
