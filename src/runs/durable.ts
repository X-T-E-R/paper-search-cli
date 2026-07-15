import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import { getSystemVersion } from "../runtime/version.js";
import { createProviderSelectionPlan } from "../search/runtime.js";
import type { ProviderSelectionRequest } from "../search/selection.js";
import { failEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import {
  assertToolArgumentsMatchSchema,
  ToolArgumentValidationError,
} from "../surface/toolArguments.js";
import {
  DURABLE_DISCOVERY_TOOL_NAMES,
  getCanonicalToolCapability,
} from "../surface/toolCatalog.js";
import { getTools } from "../surface/tools.js";
import type { ResearchRunStore } from "./store.js";
import type { TerminalRunStatus } from "./types.js";

export const DURABLE_DISCOVERY_TOOL_ALLOWLIST = DURABLE_DISCOVERY_TOOL_NAMES;

const DURABLE_DISCOVERY_TOOLS = new Set<string>(DURABLE_DISCOVERY_TOOL_ALLOWLIST);
const INTRINSICALLY_DURABLE_TOOLS = new Set([
  "research_run",
  "citation_expand",
  "assessment_run",
]);
const MANAGEMENT_OR_DESTRUCTIVE_TOOLS = new Set([
  "run_list",
  "run_show",
  "run_export",
  "run_pin",
  "run_unpin",
  "run_prune",
  "run_prune_plan",
  "citation_run_status",
  "assessment_show",
  "assessment_list",
  "resource_add",
  "artifact_download",
  "material_ingest",
  "workspace_export",
  "provider_install",
  "provider_update",
  "config_set",
  "credentials_set",
]);
const SELECTION_IDENTITY_FIELDS = [
  "platform",
  "provider",
  "presets",
  "sources",
  "categories",
  "excludeSources",
  "excludeCategories",
] as const;

export type DurableCanonicalExecutor = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<ResultEnvelope>;

export function isDurableDiscoveryTool(tool: string): boolean {
  return DURABLE_DISCOVERY_TOOLS.has(tool);
}

export function stripHistoryControl(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(args, "recordHistory")) return args;
  const { recordHistory: _recordHistory, ...toolArgs } = args;
  return toolArgs;
}

export function durableToolRejection(
  tool: string,
  args: Record<string, unknown>,
): ResultEnvelope<null> | null {
  if (args.recordHistory === false) {
    return failEnvelope({
      capability: "orchestrate",
      tool,
      errors: [
        `${tool} was invoked through an explicitly durable wrapper; use the direct tool call to opt out of history`,
      ],
      diagnostics: { reason: "durable_history_opt_out_conflict" },
    });
  }
  if (INTRINSICALLY_DURABLE_TOOLS.has(tool)) {
    return failEnvelope({
      capability: "orchestrate",
      tool,
      errors: [`${tool} already owns its durable run and cannot be wrapped`],
      diagnostics: { reason: "intrinsically_durable_tool" },
    });
  }
  if (MANAGEMENT_OR_DESTRUCTIVE_TOOLS.has(tool)) {
    return failEnvelope({
      capability: "operate",
      tool,
      errors: [`${tool} is a management, write, or destructive tool and cannot be durably wrapped`],
      diagnostics: { reason: "durable_tool_not_allowed" },
    });
  }
  if (!DURABLE_DISCOVERY_TOOLS.has(tool)) {
    return failEnvelope({
      capability: "operate",
      tool,
      errors: [`Tool is not in the durable discovery allowlist: ${tool}`],
      diagnostics: {
        reason: "durable_tool_not_allowed",
        allowedTools: [...DURABLE_DISCOVERY_TOOL_ALLOWLIST],
      },
    });
  }
  if (
    args.dryRun === true ||
    args.dry_run === true ||
    args.plan === true ||
    args.planned === true ||
    args.mode === "plan" ||
    args.apply === false
  ) {
    return failEnvelope({
      capability: "orchestrate",
      tool,
      errors: ["Plan and dry-run operations are write-free and cannot create a durable run"],
      diagnostics: { reason: "planned_operation_not_persisted" },
    });
  }
  return null;
}

async function assertDurableToolArguments(
  config: ResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const installed = await listInstalledProviders(config.providers.installDir);
  const schema = getTools(installed, { externalSearchAvailable: true })
    .find((candidate) => candidate.name === tool);
  if (!schema) throw new ToolArgumentValidationError(`Unknown canonical tool: ${tool}`);
  assertToolArgumentsMatchSchema(schema, args);
}

function requestedSelection(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const selected: Record<string, unknown> = {};
  for (const key of SELECTION_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) selected[key] = args[key];
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

async function resolvedSelectionIdentity(
  config: ResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requested = requestedSelection(args);
  if (tool === "academic_search" || tool === "patent_search") {
    try {
      const plan = await createProviderSelectionPlan(
        config,
        tool === "academic_search" ? "academic" : "patent",
        (requested ?? {}) as ProviderSelectionRequest,
      );
      return {
        requested: plan.requested,
        usedDefaults: plan.usedDefaults,
        selectedProviderIds: plan.selectedProviderIds,
        runnableProviderIds: plan.runnableProviderIds,
        skippedProviderIds: plan.skippedProviderIds,
      };
    } catch (error) {
      return {
        ...(requested ? { requested } : {}),
        resolutionError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (tool === "patent_detail") {
    return { requested, selectedProviderIds: [args.platform] };
  }
  if (tool === "resource_lookup") return { requested, runtime: "builtin-lookup" };
  return { requested, runtime: "external-search-v1" };
}

function terminalStatus(envelope: ResultEnvelope): TerminalRunStatus {
  if (!envelope.ok) return "failed";
  return Array.isArray(envelope.diagnostics?.failedSources) && envelope.diagnostics.failedSources.length > 0
    ? "partial"
    : "completed";
}

export function persistenceFailureEnvelope(tool: string, runId: string | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return failEnvelope({
    capability: "orchestrate",
    tool,
    errors: [`Durable run persistence failed: ${message}`],
    diagnostics: {
      reason: "run_persistence_failed",
      ...(runId ? { runId } : {}),
    },
  });
}

function invalidArgumentsEnvelope(tool: string, error: unknown): ResultEnvelope<null> {
  const message = error instanceof Error ? error.message : String(error);
  return failEnvelope({
    capability: getCanonicalToolCapability(tool) ?? "operate",
    tool,
    errors: [message],
    diagnostics: { reason: "invalid_arguments" },
  });
}

export async function runDurableCanonicalTool(
  config: ResolvedConfig,
  store: ResearchRunStore,
  tool: string,
  args: Record<string, unknown>,
  executeCanonicalTool: DurableCanonicalExecutor,
): Promise<ResultEnvelope> {
  const rejection = durableToolRejection(tool, args);
  if (rejection) return rejection;
  const toolArgs = stripHistoryControl(args);
  try {
    await assertDurableToolArguments(config, tool, toolArgs);
  } catch (error) {
    return invalidArgumentsEnvelope(tool, error);
  }

  const startedAt = new Date().toISOString();
  const resolvedSelection = await resolvedSelectionIdentity(config, tool, toolArgs);
  let created;
  try {
    created = await store.create({
      kind: "tool",
      request: { tool, args: toolArgs },
      resolvedSelection,
      build: { cliVersion: getSystemVersion() },
    });
  } catch (error) {
    return persistenceFailureEnvelope(tool, undefined, error);
  }

  let envelope: ResultEnvelope;
  try {
    envelope = await executeCanonicalTool(tool, toolArgs);
  } catch (error) {
    envelope = failEnvelope({
      capability: "orchestrate",
      tool,
      errors: [error instanceof Error ? error.message : String(error)],
      diagnostics: { reason: "tool_execution_failed" },
    });
  }
  const runPath = path.join(store.root, `${created.runId}.json`);
  const persistedEnvelope: ResultEnvelope = {
    ...envelope,
    diagnostics: {
      ...(envelope.diagnostics ?? {}),
      historyRecorded: true,
      runId: created.runId,
      runPath,
    },
  };
  const finishedAt = new Date().toISOString();
  try {
    await store.finish(created.runId, {
      status: terminalStatus(envelope),
      result: persistedEnvelope,
      appendProvenance: envelope.provenance ? [envelope.provenance] : [],
      appendAttempts: [{
        tool,
        startedAt,
        finishedAt,
        outcome: envelope.ok ? "success" : "failure",
      }],
      appendDiagnostics: [
        ...(envelope.diagnostics ? [envelope.diagnostics] : []),
        ...(envelope.warnings ?? []).map((message) => ({ level: "warning", message })),
        ...(envelope.errors ?? []).map((message) => ({ level: "error", message })),
      ],
    });
  } catch (error) {
    try {
      await store.finish(created.runId, {
        status: "failed",
        result: persistenceFailureEnvelope(tool, created.runId, error),
        appendDiagnostics: [{ reason: "terminal_result_persistence_failed", message: String(error) }],
      });
    } catch {
      // Retain the original running record for inspection instead of hiding it.
    }
    return persistenceFailureEnvelope(tool, created.runId, error);
  }
  return persistedEnvelope;
}
