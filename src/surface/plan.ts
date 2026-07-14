/**
 * Shared dry-run/plan contract for capability commands.
 *
 * A plan is a machine-readable ResultEnvelope with planned: true. It describes
 * the actions a caller would execute, selected policy/provider, and target
 * paths without performing writes or network calls.
 */

import { isCapabilityGroup, type CapabilityGroup } from "./capabilities.js";
import {
  okEnvelope,
  type ResultDiagnostics,
  type ResultEnvelope,
  type ResultProvenance,
} from "./resultEnvelope.js";

export const PLANNED_STEP_ACTIONS = [
  "read",
  "compute",
  "network",
  "write",
  "record",
] as const;

export type PlannedStepAction = (typeof PLANNED_STEP_ACTIONS)[number];

export const PLANNED_PROVIDER_KINDS = [
  "search",
  "web",
  "material",
  "workspace",
  "builtin",
] as const;

export type PlannedProviderKind = (typeof PLANNED_PROVIDER_KINDS)[number];

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export interface PlannedProviderSelection {
  /** Provider id, backend id, or stable built-in provider label. */
  id: string;
  /** Provider family selected for the plan. */
  kind: PlannedProviderKind;
  /** Capability groups this provider participates in for this plan. */
  capabilities?: CapabilityGroup[];
}

export interface PlannedOperationStep {
  /** Stable step id for command-specific tests and future execution reports. */
  id: string;
  /** What kind of action would be performed by the non-plan path. */
  action: PlannedStepAction;
  /** Human-readable summary of the intended operation. */
  description: string;
  /** Paths the step would read/write/create/update, when known. */
  targetPaths: string[];
  /** Provider responsible for this step, when it differs from the selected provider. */
  providerId?: string;
  /** Policy authorizing this step, when narrower than the plan-level policy. */
  policy?: string;
}

export interface PlannedOperationData {
  intendedSteps: PlannedOperationStep[];
  selectedPolicy: string | null;
  selectedProvider: PlannedProviderSelection | null;
  targetPaths: string[];
}

export interface PlanEnvelopeInit {
  capability: CapabilityGroup;
  tool: string;
  intendedSteps: readonly PlannedOperationStep[];
  selectedPolicy?: string | null;
  selectedProvider?: PlannedProviderSelection | null;
  targetPaths?: readonly string[];
  diagnostics?: ResultDiagnostics;
  warnings?: string[];
  provenance?: ResultProvenance;
}

function fail(message: string): never {
  throw new PlanValidationError(message);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value.map((entry, index) => assertNonEmptyString(entry, `${label}[${index}]`));
}

function assertCapability(value: unknown, label: string): CapabilityGroup {
  const group = assertNonEmptyString(value, label);
  if (!isCapabilityGroup(group)) {
    fail(`${label} must be a known capability group`);
  }
  return group;
}

function assertStepAction(value: unknown, label: string): PlannedStepAction {
  const action = assertNonEmptyString(value, label);
  if (!(PLANNED_STEP_ACTIONS as readonly string[]).includes(action)) {
    fail(`${label} must be one of: ${PLANNED_STEP_ACTIONS.join(", ")}`);
  }
  return action as PlannedStepAction;
}

function assertProviderKind(value: unknown, label: string): PlannedProviderKind {
  const kind = assertNonEmptyString(value, label);
  if (!(PLANNED_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    fail(`${label} must be one of: ${PLANNED_PROVIDER_KINDS.join(", ")}`);
  }
  return kind as PlannedProviderKind;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeProvider(
  value: PlannedProviderSelection | null | undefined,
): PlannedProviderSelection | null {
  if (value === undefined || value === null) return null;
  return {
    id: assertNonEmptyString(value.id, "selectedProvider.id"),
    kind: assertProviderKind(value.kind, "selectedProvider.kind"),
    ...(value.capabilities !== undefined
      ? {
          capabilities: unique(
            value.capabilities.map((capability, index) =>
              assertCapability(capability, `selectedProvider.capabilities[${index}]`),
            ),
          ) as CapabilityGroup[],
        }
      : {}),
  };
}

function normalizeStep(step: PlannedOperationStep, index: number): PlannedOperationStep {
  const prefix = `intendedSteps[${index}]`;
  return {
    id: assertNonEmptyString(step.id, `${prefix}.id`),
    action: assertStepAction(step.action, `${prefix}.action`),
    description: assertNonEmptyString(step.description, `${prefix}.description`),
    targetPaths: unique(assertStringArray(step.targetPaths, `${prefix}.targetPaths`)),
    ...(step.providerId !== undefined
      ? { providerId: assertNonEmptyString(step.providerId, `${prefix}.providerId`) }
      : {}),
    ...(step.policy !== undefined
      ? { policy: assertNonEmptyString(step.policy, `${prefix}.policy`) }
      : {}),
  };
}

function normalizePolicy(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return assertNonEmptyString(value, "selectedPolicy");
}

function mergeProvenance(
  init: PlanEnvelopeInit,
  selectedProvider: PlannedProviderSelection | null,
  selectedPolicy: string | null,
): ResultProvenance | undefined {
  const provenance: ResultProvenance = { ...(init.provenance ?? {}) };
  if (selectedProvider) {
    provenance.providerIds = unique([...(provenance.providerIds ?? []), selectedProvider.id]);
  }
  if (selectedPolicy) {
    provenance.policy = selectedPolicy;
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

export function createPlanEnvelope(
  init: PlanEnvelopeInit,
): ResultEnvelope<PlannedOperationData> {
  const capability = assertCapability(init.capability, "capability");
  const tool = assertNonEmptyString(init.tool, "tool");
  if (!Array.isArray(init.intendedSteps) || init.intendedSteps.length === 0) {
    fail("intendedSteps must be a non-empty array");
  }

  const intendedSteps = init.intendedSteps.map((step, index) => normalizeStep(step, index));
  const selectedPolicy = normalizePolicy(init.selectedPolicy);
  const selectedProvider = normalizeProvider(init.selectedProvider);
  const targetPaths = unique([
    ...assertStringArray(init.targetPaths ?? [], "targetPaths"),
    ...intendedSteps.flatMap((step) => step.targetPaths),
  ]);
  const provenance = mergeProvenance(init, selectedProvider, selectedPolicy);

  return okEnvelope({
    capability,
    tool,
    planned: true,
    data: {
      intendedSteps,
      selectedPolicy,
      selectedProvider,
      targetPaths,
    },
    ...(init.diagnostics ? { diagnostics: init.diagnostics } : {}),
    ...(init.warnings ? { warnings: init.warnings } : {}),
    ...(provenance ? { provenance } : {}),
  });
}
