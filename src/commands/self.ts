import type { Command } from "commander";
import type { Io } from "../runtime/io.js";
import { formatInstallHealthWarnings, inspectInstallHealth } from "../runtime/installLayout.js";
import {
  createSelfUpdateService,
  SelfUpdateBlockedError,
  type SelfModePlan,
  type SelfUpdatePlan,
  type SourceManagementMode,
} from "../runtime/selfUpdate.js";
import { PRODUCTION_OFFICIAL_ORIGIN_POLICY } from "../runtime/selfUpdatePolicy.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";

interface SelfStatusOptions {
  json?: boolean;
}

interface SelfMutationOptions {
  apply?: boolean;
  json?: boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeBlockedPlan(io: Io, plan: SelfModePlan | SelfUpdatePlan): void {
  io.writeLine(`${plan.operation} plan: blocked`);
  io.writeLine(`plan digest: ${plan.planDigest}`);
  for (const blocker of plan.blockers) io.writeLine(`blocked: ${blocker}`);
}

function writeModePlan(io: Io, result: { plan: SelfModePlan; applied: boolean }): void {
  const { plan } = result;
  io.writeLine(`management mode: ${plan.before ?? "unmanaged"} -> ${plan.after}`);
  io.writeLine(`official origin policy: ${plan.officialPolicy.status}`);
  if (plan.blocked) {
    writeBlockedPlan(io, plan);
    return;
  }
  io.writeLine(`plan digest: ${plan.planDigest}`);
  io.writeLine(result.applied ? "Mode change applied." : plan.actions.length ? "No files changed. Re-run with --apply." : "No change required.");
}

function writeUpdatePlan(io: Io, result: { plan: SelfUpdatePlan; applied: boolean }): void {
  const { plan } = result;
  io.writeLine(`official origin policy: ${plan.officialPolicy.status}`);
  io.writeLine(`checkout relation: ${plan.relation}`);
  io.writeLine(`current commit: ${plan.git.head ?? "unavailable"}`);
  io.writeLine(`target commit: ${plan.targetCommit ?? "unavailable"}`);
  if (plan.blocked) {
    writeBlockedPlan(io, plan);
    return;
  }
  io.writeLine(`plan digest: ${plan.planDigest}`);
  io.writeLine(result.applied ? "Self-update applied." : plan.actions.length ? "No checkout changes made. Re-run with --apply." : "Already up to date.");
}

export function registerSelfCommands(program: Command, io: Io): void {
  const service = createSelfUpdateService({
    officialOriginPolicy: PRODUCTION_OFFICIAL_ORIGIN_POLICY,
  });
  const self = program.command("self").description("Inspect and manage the retained Paper Search checkout.");

  self
    .command("status")
    .description("Show build identity, Git/upstream state, update mode, projections, and shim health.")
    .option("--json", "emit a machine-readable envelope")
    .action(async (options: SelfStatusOptions) => {
      const [health, checkout] = await Promise.all([inspectInstallHealth(), service.inspectStatus()]);
      const warnings = [
        ...formatInstallHealthWarnings(health),
        ...(health.path.onPath ? [] : [`Managed bin root is not on PATH: ${health.path.binRoot}`]),
        ...(checkout.officialPolicy.status === "unavailable"
          ? [checkout.officialPolicy.reason ?? "Official self-update origin policy is unavailable."]
          : []),
        ...(checkout.pendingRecovery
          ? [`Self-update recovery is pending: ${checkout.pendingRecoveryPath}`]
          : []),
      ];
      const envelope = okEnvelope({
        capability: "operate",
        tool: "self_status",
        data: { ...health, checkout },
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      if (options.json) {
        io.writeJson(envelope);
        return;
      }
      io.writeLine(`checkout: ${health.paths.repoRoot}`);
      io.writeLine(`build: ${health.build?.packageVersion ?? "missing"}`);
      io.writeLine(`installation health: ${health.summary.status}`);
      io.writeLine(`management mode: ${checkout.sourceManagementMode ?? "unmanaged"}`);
      io.writeLine(`Git branch: ${checkout.git.branch ?? "unavailable"}`);
      io.writeLine(`Git upstream: ${checkout.git.upstream ?? "unavailable"}`);
      io.writeLine(
        `Git ahead/behind: ${checkout.git.cachedAhead ?? "unknown"}/${checkout.git.cachedBehind ?? "unknown"}`,
      );
      io.writeLine(`official origin policy: ${checkout.officialPolicy.status}`);
      io.writeLine(`skill projections: ${health.projections.filter((entry) => entry.healthy).length}/${health.projections.length} healthy`);
      io.writeLine(`CLI shims: ${health.shims.filter((entry) => entry.healthy).length}/${health.shims.length} healthy`);
      for (const warning of warnings) io.writeLine(`warning: ${warning}`);
    });

  self
    .command("mode [mode]")
    .description("Show or plan a change between user-managed and explicit self-update mode.")
    .option("--apply", "persist the displayed mode-change plan")
    .option("--json", "emit a machine-readable envelope")
    .action(async (mode: string | undefined, options: SelfMutationOptions) => {
      if (!mode) {
        if (options.apply) throw new Error("self mode --apply requires user-managed or self-update");
        const status = await service.inspectStatus();
        const envelope = okEnvelope({
          capability: "operate",
          tool: "self_mode",
          data: {
            sourceManagementMode: status.sourceManagementMode ?? "unmanaged",
            officialPolicy: status.officialPolicy,
          },
        });
        if (options.json) io.writeJson(envelope);
        else {
          io.writeLine(`management mode: ${status.sourceManagementMode ?? "unmanaged"}`);
          io.writeLine(`official origin policy: ${status.officialPolicy.status}`);
        }
        return;
      }
      if (mode !== "user-managed" && mode !== "self-update") {
        throw new Error(`Invalid source-management mode: ${mode}`);
      }
      try {
        const result = await service.executeMode(mode as SourceManagementMode, Boolean(options.apply));
        const envelope = okEnvelope({
          capability: "operate",
          tool: "self_mode",
          planned: !result.applied,
          data: result,
          ...(result.auditWarnings ? { warnings: result.auditWarnings } : {}),
          provenance: { policy: result.plan.officialPolicy.policyId },
        });
        if (options.json) io.writeJson(envelope);
        else writeModePlan(io, result);
      } catch (error) {
        const plan = error instanceof SelfUpdateBlockedError ? error.plan : null;
        if (!options.json) throw error;
        io.writeJson(
          failEnvelope({
            capability: "operate",
            tool: "self_mode",
            errors: [formatError(error)],
            ...(plan ? { diagnostics: { plan } } : {}),
          }),
        );
        process.exitCode = 1;
      }
    });

  self
    .command("update")
    .description("Plan or apply an official fast-forward checkout update.")
    .option("--apply", "build, verify, and apply the displayed fast-forward target")
    .option("--json", "emit a machine-readable envelope")
    .action(async (options: SelfMutationOptions) => {
      try {
        const result = await service.executeUpdate(Boolean(options.apply));
        const envelope = okEnvelope({
          capability: "operate",
          tool: "self_update",
          planned: !result.applied,
          data: result,
          ...(result.auditWarnings ? { warnings: result.auditWarnings } : {}),
          provenance: { policy: result.plan.officialPolicy.policyId },
        });
        if (options.json) io.writeJson(envelope);
        else writeUpdatePlan(io, result);
      } catch (error) {
        const plan = error instanceof SelfUpdateBlockedError ? error.plan : null;
        if (!options.json) throw error;
        io.writeJson(
          failEnvelope({
            capability: "operate",
            tool: "self_update",
            errors: [formatError(error)],
            ...(plan ? { diagnostics: { plan } } : {}),
          }),
        );
        process.exitCode = 1;
      }
    });
}
