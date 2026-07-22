import { z } from "zod";
import type {
  AssessmentIdentityEvidence,
  AssessmentObservation,
  AssessmentPolicy,
  AssessmentSignal,
  AssessmentSnapshot,
} from "./types.js";

const nonEmpty = z.string().trim().min(1);
const identifierKey = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u);
const identifierValue = z.string().trim().min(1).max(1024);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const instant = z.string().datetime({ offset: true });

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const identifiersSchema = z.record(identifierKey, identifierValue).refine(
  (value) => Object.keys(value).length > 0,
  "at least one exact identifier is required",
);

const subjectSchema = z
  .object({
    kind: z.enum(["work", "venue"]),
    canonicalId: nonEmpty.max(1024),
    identifiers: identifiersSchema,
  })
  .strict();

function sourceUrlIsSafe(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|token|secret|password|authorization|credential|cookie)/iu.test(key)) return false;
    }
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const sourceSchema = z
  .object({
    providerId: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u),
    providerVersion: nonEmpty.max(128),
    providerReceiptDigest: sha256.optional(),
    sourceRecordId: nonEmpty.max(2048).optional(),
    sourceUrl: z.string().refine(sourceUrlIsSafe, "sourceUrl must be HTTP(S) and contain no credentials").optional(),
    datasetVersion: nonEmpty.max(256).optional(),
    sourceKind: z.enum(["publisher", "retraction-watch", "provider-api", "user-snapshot"]).optional(),
  })
  .strict();

const timeScopeSchema = z
  .object({
    start: instant.optional(),
    end: instant.optional(),
    label: nonEmpty.max(256).optional(),
  })
  .strict()
  .refine((value) => value.start !== undefined || value.end !== undefined || value.label !== undefined, {
    message: "timeScope must define start, end, or label",
  })
  .refine((value) => !value.start || !value.end || Date.parse(value.start) <= Date.parse(value.end), {
    message: "timeScope.start must not be after timeScope.end",
  });

const signalSchema: z.ZodType<AssessmentSignal> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity_resolution") }).strict(),
  z
    .object({
      kind: z.literal("citation_count"),
      metricDefinition: nonEmpty.max(512),
      timeScope: timeScopeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("venue_metric"),
      metricName: nonEmpty.max(256),
      metricDefinition: nonEmpty.max(512),
      metricYear: z.number().int().min(1800).max(3000).optional(),
      unit: nonEmpty.max(128).optional(),
      subjectCategory: nonEmpty.max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("post_publication_event"),
      eventType: z.enum(["retraction", "correction", "expression_of_concern", "reinstatement", "other"]),
    })
    .strict(),
  z.object({ kind: z.literal("access"), field: nonEmpty.max(256) }).strict(),
  z.object({ kind: z.literal("bibliographic_lifecycle"), field: nonEmpty.max(256) }).strict(),
]);

const diagnosticsSchema = z.object({ code: nonEmpty.max(128), message: nonEmpty.max(2048) }).strict();

const observationSchema = z
  .object({
    observationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
    subject: subjectSchema,
    signal: signalSchema,
    status: z.enum(["found", "not_found", "unavailable", "error", "ambiguous"]),
    value: jsonValueSchema.optional(),
    observedAt: instant,
    sourceTimestamp: instant.optional(),
    effectiveAt: instant.optional(),
    source: sourceSchema,
    scope: nonEmpty.max(1024).optional(),
    caveats: z.array(nonEmpty.max(2048)).max(100).optional(),
    rawEvidenceDigest: sha256.optional(),
    diagnostics: diagnosticsSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.status === "found" && observation.value === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "found observations require value" });
      return;
    }
    if (observation.status !== "found" && observation.value !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${observation.status} observations must not claim a value`,
      });
    }
    if ((observation.status === "unavailable" || observation.status === "error") && !observation.diagnostics) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnostics"],
        message: `${observation.status} observations require diagnostics`,
      });
    }
    if (observation.status !== "found") return;
    const value = observation.value;
    switch (observation.signal.kind) {
      case "citation_count":
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "citation_count must be a non-negative safe integer" });
        }
        break;
      case "venue_metric":
        if (typeof value !== "number" && typeof value !== "string") {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "venue_metric must be a number or source label" });
        }
        break;
      case "identity_resolution":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "identity_resolution must be an object" });
        } else {
          const identity = value as Record<string, unknown>;
          const allowed = new Set(["matchedIdentifiers", "matchMethod", "canonicalId"]);
          if (Object.keys(identity).some((key) => !allowed.has(key))) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "identity_resolution contains an unsupported field" });
          }
          if (
            typeof identity.matchedIdentifiers !== "object" ||
            identity.matchedIdentifiers === null ||
            Array.isArray(identity.matchedIdentifiers) ||
            !["exact_identifier", "provider_asserted", "title_only", "manual"].includes(String(identity.matchMethod))
          ) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "identity_resolution requires matchedIdentifiers and matchMethod" });
          }
        }
        break;
      case "post_publication_event":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "post_publication_event must be an object" });
        } else {
          const event = value as Record<string, unknown>;
          const allowed = new Set(["originalId", "noticeId", "relation", "description"]);
          if (
            Object.keys(event).length === 0 ||
            Object.entries(event).some(([key, entry]) => !allowed.has(key) || typeof entry !== "string" || entry.trim() === "")
          ) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "post_publication_event requires non-empty named event evidence" });
          }
        }
        break;
      case "access":
        if (
          typeof value !== "boolean" &&
          typeof value !== "string" &&
          !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
        ) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "access must be a boolean, string, or string array" });
        }
        break;
      case "bibliographic_lifecycle":
        if (
          typeof value !== "string" &&
          !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
        ) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "bibliographic_lifecycle must be a string or string array" });
        }
        break;
    }
  });

const identityEvidenceSchema = z
  .object({
    evidenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
    status: z.enum(["found", "not_found", "unavailable", "error", "ambiguous"]),
    inputIdentifiers: identifiersSchema,
    matchedSubject: subjectSchema.optional(),
    matchedIdentifiers: identifiersSchema.optional(),
    matchMethod: z.enum(["exact_identifier", "provider_asserted", "title_only", "manual"]).optional(),
    observedAt: instant,
    source: sourceSchema,
    candidates: z.array(subjectSchema).max(100).optional(),
    caveats: z.array(nonEmpty.max(2048)).max(100).optional(),
    diagnostics: diagnosticsSchema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === "found") {
      if (!evidence.matchedSubject || !evidence.matchedIdentifiers || !evidence.matchMethod) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "found identity evidence requires matched subject, identifiers, and method" });
      }
      if (evidence.matchMethod === "exact_identifier" && evidence.matchedIdentifiers) {
        const exact = Object.entries(evidence.matchedIdentifiers).some(
          ([key, value]) => evidence.inputIdentifiers[key] === value,
        );
        if (!exact) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "exact_identifier evidence must match an input identifier exactly" });
        }
      }
    } else if (evidence.matchedSubject || evidence.matchedIdentifiers || evidence.matchMethod) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${evidence.status} identity evidence must not claim a match` });
    }
    if (evidence.status === "ambiguous" && (!evidence.candidates || evidence.candidates.length < 2)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "ambiguous identity evidence requires at least two candidates" });
    }
    if ((evidence.status === "unavailable" || evidence.status === "error") && !evidence.diagnostics) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["diagnostics"], message: `${evidence.status} identity evidence requires diagnostics` });
    }
  });

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
    createdAt: instant,
    source: z
      .object({
        providerId: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u),
        providerVersion: nonEmpty.max(128),
        datasetVersion: nonEmpty.max(256).optional(),
        sourceKind: z.literal("user-snapshot"),
      })
      .strict(),
    identityEvidence: z.array(identityEvidenceSchema).max(100_000),
    observations: z.array(observationSchema).max(1_000_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const observationIds = new Set<string>();
    for (const [index, observation] of snapshot.observations.entries()) {
      if (observationIds.has(observation.observationId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["observations", index, "observationId"], message: "duplicate observationId" });
      }
      observationIds.add(observation.observationId);
    }
    const evidenceIds = new Set<string>();
    for (const [index, evidence] of snapshot.identityEvidence.entries()) {
      if (evidenceIds.has(evidence.evidenceId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["identityEvidence", index, "evidenceId"], message: "duplicate evidenceId" });
      }
      evidenceIds.add(evidence.evidenceId);
    }
  });

const conditionSchema = z
  .object({
    signal: signalSchema,
    subjectKind: z.enum(["work", "venue"]).optional(),
    subjectCanonicalId: nonEmpty.max(1024).optional(),
    providers: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/u)).min(1).max(100).optional(),
    statuses: z.array(z.enum(["found", "not_found", "unavailable", "error", "ambiguous"])).min(1).max(5).optional(),
    operator: z.enum([
      "exists",
      "equals",
      "not_equals",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "contains",
    ]),
    value: jsonValueSchema.optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    const valueRequired = condition.operator !== "exists";
    if (valueRequired && condition.value === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${condition.operator} requires value` });
    }
    if (!valueRequired && condition.value !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "exists does not accept value" });
    }
    if (typeof condition.value === "number") {
      if (condition.signal.kind === "citation_count" && condition.signal.timeScope === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["signal", "timeScope"], message: "numeric citation policy requires an explicit timeScope" });
      }
      if (condition.signal.kind === "venue_metric" && condition.signal.metricYear === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["signal", "metricYear"], message: "numeric venue policy requires an explicit metricYear" });
      }
    }
  });

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    name: nonEmpty.max(256),
    version: nonEmpty.max(128),
    rules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
            description: nonEmpty.max(2048).optional(),
            all: z.array(conditionSchema).min(1).max(100),
            action: z.enum(["include", "exclude", "review"]),
          })
          .strict(),
      )
      .max(1000),
    defaultAction: z.literal("review").optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    for (const [index, rule] of policy.rules.entries()) {
      if (ids.has(rule.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["rules", index, "id"], message: "duplicate policy rule id" });
      }
      ids.add(rule.id);
    }
  });

function parseWithLabel<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${detail}`);
}

export function parseAssessmentObservation(value: unknown): AssessmentObservation {
  return parseWithLabel(observationSchema, value, "assessment observation") as AssessmentObservation;
}

export function parseAssessmentIdentityEvidence(value: unknown): AssessmentIdentityEvidence {
  return parseWithLabel(identityEvidenceSchema, value, "assessment identity evidence") as AssessmentIdentityEvidence;
}

export function parseAssessmentSnapshot(value: unknown): AssessmentSnapshot {
  return parseWithLabel(snapshotSchema, value, "assessment snapshot") as AssessmentSnapshot;
}

export function parseAssessmentPolicy(value: unknown): AssessmentPolicy {
  return parseWithLabel(policySchema, value, "assessment policy") as AssessmentPolicy;
}
