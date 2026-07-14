import type { JsonValue } from "./canonical.js";

export const ASSESSMENT_SCHEMA_VERSION = 1 as const;

export type AssessmentSubjectKind = "work" | "venue";
export type AssessmentCoverageStatus = "found" | "not_found" | "unavailable" | "error" | "ambiguous";
export type AssessmentDisposition = "include" | "exclude" | "review";
export type PostPublicationEventType =
  | "retraction"
  | "correction"
  | "expression_of_concern"
  | "reinstatement"
  | "other";

export interface AssessmentSubject {
  kind: AssessmentSubjectKind;
  /** Stable, exact identity selected before signal comparison (for example doi:10.1234/example). */
  canonicalId: string;
  identifiers: Record<string, string>;
}

export interface AssessmentSource {
  providerId: string;
  providerVersion: string;
  providerReceiptDigest?: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  datasetVersion?: string;
  sourceKind?: "publisher" | "retraction-watch" | "provider-api" | "user-snapshot";
}

export type AssessmentSignal =
  | { kind: "identity_resolution" }
  | {
      kind: "citation_count";
      metricDefinition: string;
      timeScope?: { start?: string; end?: string; label?: string };
    }
  | {
      kind: "venue_metric";
      metricName: string;
      metricDefinition: string;
      metricYear?: number;
      unit?: string;
      subjectCategory?: string;
    }
  | {
      kind: "post_publication_event";
      eventType: PostPublicationEventType;
    }
  | {
      kind: "access";
      field: string;
    }
  | {
      kind: "bibliographic_lifecycle";
      field: string;
    };

interface AssessmentObservationBase<S extends AssessmentSignal> {
  observationId: string;
  subject: AssessmentSubject;
  signal: S;
  observedAt: string;
  sourceTimestamp?: string;
  effectiveAt?: string;
  source: AssessmentSource;
  scope?: string;
  caveats?: string[];
  rawEvidenceDigest?: string;
  diagnostics?: { code: string; message: string };
}

type NonFoundAssessmentObservation<S extends AssessmentSignal> = AssessmentObservationBase<S> & {
  status: Exclude<AssessmentCoverageStatus, "found">;
  value?: never;
};

type FoundAssessmentObservation<S extends AssessmentSignal, V> = AssessmentObservationBase<S> & {
  status: "found";
  value: V;
};

type TypedAssessmentObservation<S extends AssessmentSignal, V> =
  | FoundAssessmentObservation<S, V>
  | NonFoundAssessmentObservation<S>;

export interface IdentityResolutionObservationValue {
  matchedIdentifiers: Record<string, string>;
  matchMethod: IdentityMatchMethod;
  canonicalId?: string;
}

export interface PostPublicationEventValue {
  originalId?: string;
  noticeId?: string;
  relation?: string;
  description?: string;
}

export type AssessmentObservation =
  | TypedAssessmentObservation<Extract<AssessmentSignal, { kind: "identity_resolution" }>, IdentityResolutionObservationValue>
  | TypedAssessmentObservation<Extract<AssessmentSignal, { kind: "citation_count" }>, number>
  | TypedAssessmentObservation<Extract<AssessmentSignal, { kind: "venue_metric" }>, number | string>
  | TypedAssessmentObservation<Extract<AssessmentSignal, { kind: "post_publication_event" }>, PostPublicationEventValue>
  | TypedAssessmentObservation<
      Extract<AssessmentSignal, { kind: "access" }>,
      boolean | string | string[]
    >
  | TypedAssessmentObservation<
      Extract<AssessmentSignal, { kind: "bibliographic_lifecycle" }>,
      string | string[]
    >;

export type IdentityMatchMethod = "exact_identifier" | "provider_asserted" | "title_only" | "manual";

export interface AssessmentIdentityEvidence {
  evidenceId: string;
  status: AssessmentCoverageStatus;
  inputIdentifiers: Record<string, string>;
  matchedSubject?: AssessmentSubject;
  matchedIdentifiers?: Record<string, string>;
  matchMethod?: IdentityMatchMethod;
  observedAt: string;
  source: AssessmentSource;
  candidates?: AssessmentSubject[];
  caveats?: string[];
  diagnostics?: { code: string; message: string };
}

export interface AssessmentSnapshot {
  schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  snapshotId: string;
  createdAt: string;
  source: {
    providerId: string;
    providerVersion: string;
    datasetVersion?: string;
    sourceKind: "user-snapshot";
  };
  identityEvidence: AssessmentIdentityEvidence[];
  observations: AssessmentObservation[];
}

export interface AssessmentSnapshotRef {
  path: string;
  /** SHA-256 of the exact local file bytes. A path without this binding is not accepted. */
  sha256: string;
}

export interface LoadedAssessmentSnapshot {
  ref: { path: string; sha256: string };
  canonicalDigest: string;
  snapshot: AssessmentSnapshot;
}

export interface AssessmentConflict {
  conflictId: string;
  subjectKey: string;
  signalKey: string;
  comparisonKey: string;
  observationIds: string[];
  valueDigests: string[];
  reason: string;
}

export type AssessmentConditionOperator =
  | "exists"
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "contains";

export interface AssessmentPolicyCondition {
  signal: AssessmentSignal;
  subjectKind?: AssessmentSubjectKind;
  subjectCanonicalId?: string;
  providers?: string[];
  statuses?: AssessmentCoverageStatus[];
  operator: AssessmentConditionOperator;
  value?: JsonValue;
  /** Missing or conflicting evidence for a required condition produces review. */
  required?: boolean;
}

export interface AssessmentPolicyRule {
  id: string;
  description?: string;
  all: AssessmentPolicyCondition[];
  action: AssessmentDisposition;
}

export interface AssessmentPolicy {
  schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  name: string;
  version: string;
  rules: AssessmentPolicyRule[];
  defaultAction?: "review";
}

export interface AssessmentPolicyConditionTrace {
  conditionIndex: number;
  outcome: "matched" | "not_matched" | "missing" | "conflict";
  observationIds: string[];
  conflictIds: string[];
  detail: string;
}

export interface AssessmentPolicyRuleTrace {
  ruleId: string;
  outcome: "matched" | "not_matched" | "review_missing" | "review_conflict";
  observationIds: string[];
  conflictIds: string[];
  conditions: AssessmentPolicyConditionTrace[];
}

export interface AssessmentPolicyEvaluation {
  disposition: AssessmentDisposition;
  policy: { name: string; version: string; digest: string };
  decidedByRuleId: string | null;
  observationIds: string[];
  conflictIds: string[];
  trace: AssessmentPolicyRuleTrace[];
}

export interface AssessmentReport {
  schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  snapshot: LoadedAssessmentSnapshot["ref"] & {
    snapshotId: string;
    canonicalDigest: string;
    createdAt: string;
    source: AssessmentSnapshot["source"];
  };
  identityEvidence: AssessmentIdentityEvidence[];
  observations: AssessmentObservation[];
  conflicts: AssessmentConflict[];
  policy: (AssessmentPolicy & { digest: string }) | null;
  evaluation: AssessmentPolicyEvaluation | null;
  /** Digest excludes this field and is stable across equivalent JSON key order. */
  resultDigest: string;
}

export interface AssessmentRunRequestRecord {
  snapshot: AssessmentSnapshotRef;
  policyDigest: string | null;
}

export interface AssessmentRunPayload {
  schemaVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  kind: "assessment";
  request: AssessmentRunRequestRecord;
  report: AssessmentReport;
}
