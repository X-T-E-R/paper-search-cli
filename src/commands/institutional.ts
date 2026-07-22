import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import {
  cancelInstitutionalJob,
  continueInstitutionalJob,
  probeInstitutional,
  showInstitutionalJob,
  statusInstitutionalJobs,
} from "../institutional/service.js";
import type { Io } from "../runtime/io.js";
import { failEnvelope, okEnvelope } from "../surface/resultEnvelope.js";
import {
  issueInstitutionalAgentGrant,
  revokeInstitutionalAgentGrants,
  setInstitutionalAgentPolicy,
  showInstitutionalAgentPolicy,
  type InstitutionalAgentMode,
} from "../institutional/agentAuth.js";

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function assertInteractiveAuthorizationMutation(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("Institutional agent authorization must be changed by the user in a local interactive TTY.");
  }
}

export function registerInstitutionalCommands(program: Command, io: Io): void {
  const institutional = program.command("institutional")
    .description("Inspect and locally continue opt-in institutional browser acquisition jobs.");

  institutional.command("status [jobId]").option("--json", "emit machine-readable JSON envelope")
    .action(async (jobId: string | undefined, _options: unknown, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const data = jobId ? await showInstitutionalJob(config, jobId) : await statusInstitutionalJobs(config);
        io.writeJson(data === null
          ? failEnvelope({ capability: "acquire", tool: "institutional_status", errors: [`Institutional job not found: ${jobId}`] })
          : okEnvelope({ capability: "acquire", tool: "institutional_status", data }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_status", errors: [message(error)] }));
      }
    });

  institutional.command("show <jobId>").option("--json", "emit machine-readable JSON envelope")
    .action(async (jobId: string, _options: unknown, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const job = await showInstitutionalJob(config, jobId);
        io.writeJson(job
          ? okEnvelope({ capability: "acquire", tool: "institutional_job_show", data: { job } })
          : failEnvelope({ capability: "acquire", tool: "institutional_job_show", errors: [`Institutional job not found: ${jobId}`] }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_job_show", errors: [message(error)] }));
      }
    });

  institutional.command("probe").option("--json", "emit machine-readable JSON envelope")
    .action(async (_options: unknown, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const probe = await probeInstitutional(config);
        io.writeJson(okEnvelope({ capability: "acquire", tool: "institutional_probe", data: probe }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_probe", errors: [message(error)] }));
      }
    });

  institutional.command("continue <jobId>")
    .option("--agent-assisted", "authorize a non-TTY agent-assisted attempt under the user policy")
    .option("--grant <id>", "consume a one-attempt grant while agent policy is ask")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (jobId: string, options: { agentAssisted?: boolean; grant?: string }, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const result = await continueInstitutionalJob({
          config,
          id: jobId,
          agentAssisted: options.agentAssisted,
          grantId: options.grant,
        });
        const actionRequired = result.job.status === "action_required";
        io.writeJson(okEnvelope({
          capability: "acquire",
          tool: "institutional_continue",
          data: result,
          ...(actionRequired ? {
            state: "action_required" as const,
            actions: [{ id: `continue-${jobId}`, kind: "continue_institutional" as const, target: { kind: "institutional_job" as const, id: jobId }, command: `paper-search institutional continue ${jobId}` }],
          } : {}),
        }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_continue", errors: [message(error)] }));
      }
    });

  const agentPolicy = institutional.command("agent-policy")
    .description("Inspect or update user-level agent-assisted continuation policy.");

  agentPolicy.command("show").option("--json", "emit machine-readable JSON envelope")
    .action(async (_options: unknown, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        io.writeJson(okEnvelope({ capability: "acquire", tool: "institutional_agent_policy_show", data: showInstitutionalAgentPolicy(config) }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_agent_policy_show", errors: [message(error)] }));
      }
    });

  agentPolicy.command("set <mode>")
    .option("--profile <id>", "explicit profile to add when mode is allow")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (mode: string, options: { profile?: string }, command: Command) => {
      try {
        if (!(["ask", "allow", "off"] as string[]).includes(mode)) throw new Error("Agent policy mode must be ask, allow, or off.");
        assertInteractiveAuthorizationMutation();
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const policy = await setInstitutionalAgentPolicy({ config, mode: mode as InstitutionalAgentMode, profileId: options.profile });
        io.writeJson(okEnvelope({ capability: "acquire", tool: "institutional_agent_policy_set", data: policy }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_agent_policy_set", errors: [message(error)] }));
      }
    });

  const agentGrant = institutional.command("agent-grant")
    .description("Issue or revoke short-lived one-attempt authorization receipts.");

  agentGrant.command("issue <jobId>")
    .option("--ttl <seconds>", "grant lifetime in seconds", "600")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (jobId: string, options: { ttl: string }, command: Command) => {
      try {
        assertInteractiveAuthorizationMutation();
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const grant = await issueInstitutionalAgentGrant({ config, jobId, ttlSeconds: Number(options.ttl) });
        io.writeJson(okEnvelope({
          capability: "acquire",
          tool: "institutional_agent_grant_issue",
          data: {
            id: grant.id,
            status: grant.status,
            jobId: grant.jobId,
            profileId: grant.profileId,
            attemptNumber: grant.attemptNumber,
            expiresAt: grant.expiresAt,
          },
        }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_agent_grant_issue", errors: [message(error)] }));
      }
    });

  agentGrant.command("revoke [grantId]")
    .option("--all", "revoke all active grants")
    .option("--json", "emit machine-readable JSON envelope")
    .action(async (grantId: string | undefined, options: { all?: boolean }, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const result = await revokeInstitutionalAgentGrants({ config, grantId, all: options.all });
        io.writeJson(okEnvelope({ capability: "acquire", tool: "institutional_agent_grant_revoke", data: result }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_agent_grant_revoke", errors: [message(error)] }));
      }
    });

  institutional.command("cancel <jobId>").option("--json", "emit machine-readable JSON envelope")
    .action(async (jobId: string, _options: unknown, command: Command) => {
      try {
        const config = await loadConfig({ explicitConfigPath: command.optsWithGlobals<{ config?: string }>().config });
        const job = await cancelInstitutionalJob(config, jobId);
        io.writeJson(okEnvelope({ capability: "acquire", tool: "institutional_cancel", data: { job } }));
      } catch (error) {
        io.writeJson(failEnvelope({ capability: "acquire", tool: "institutional_cancel", errors: [message(error)] }));
      }
    });
}
