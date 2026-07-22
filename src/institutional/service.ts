import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import { commitInstitutionalArtifact, type ArtifactDownloadResultEnvelope } from "../material/artifactDownload.js";
import {
  institutionalJobRoot,
  listInstitutionalJobs,
  readInstitutionalJob,
  withInstitutionalJobLock,
  type InstitutionalJob,
  type InstitutionalJobStatus,
} from "./jobStore.js";
import {
  ProcessInstitutionalRunner,
  createInstitutionalRequest,
  verifyInstitutionalHandoff,
  type InstitutionalRunner,
} from "./runner.js";
import type { InstitutionalRunnerResponse } from "./protocol.js";
import { consumeInstitutionalAgentGrant } from "./agentAuth.js";

export interface InstitutionalJobView {
  id: string;
  status: InstitutionalJobStatus;
  doi: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  reasonCode?: string;
  message?: string;
  artifactId?: string;
  continueCommand?: string;
}

export interface InstitutionalProbeResult {
  status: "disabled" | "unconfigured" | "ready" | "unavailable";
  reasonCode?: string;
  message: string;
}

function view(job: InstitutionalJob): InstitutionalJobView {
  return {
    id: job.id,
    status: job.status,
    doi: job.doi,
    profileId: job.profileId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    attemptCount: job.attemptCount,
    ...(job.reasonCode ? { reasonCode: job.reasonCode } : {}),
    ...(job.message ? { message: job.message } : {}),
    ...(job.artifactId ? { artifactId: job.artifactId } : {}),
    ...(["queued", "action_required", "failed"].includes(job.status)
      ? { continueCommand: `paper-search institutional continue ${job.id}` }
      : {}),
  };
}

function assertConfigured(config: ResolvedConfig): void {
  if (!config.institutional.enabled) throw new Error("Institutional browser acquisition is disabled in the conventional user config.");
  if (!config.institutional.pythonExecutable || !config.institutional.checkoutRoot) {
    throw new Error("Institutional browser acquisition requires an absolute Python executable and pinned InstSci checkout.");
  }
}

function assertPinnedContext(config: ResolvedConfig, job: InstitutionalJob): void {
  const expected = {
    configRoot: path.dirname(path.resolve(config.meta.userConfigPath)),
    contextId: config.context.id,
    workspaceRoot: path.resolve(config.workspace.root),
    artifactRoot: path.resolve(config.storage.artifactRoot),
    jobRoot: path.resolve(institutionalJobRoot(config)),
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (job.roots[key] !== expected[key]) {
      throw new Error(`Institutional job context drift detected for ${key}; return to the captured project/config context before continuing.`);
    }
  }
}

function terminalMessage(status: InstitutionalRunnerResponse["status"]): string {
  switch (status) {
    case "action_required": return "Visible institutional sign-in or user action is required; retry the continuation command afterward.";
    case "not_entitled": return "The active institutional session did not provide access to this paper.";
    case "unsupported": return "The pinned institutional adapter does not support this DOI publisher.";
    case "failed": return "The institutional browser attempt did not produce a verified PDF.";
    default: return "Institutional sidecar state updated.";
  }
}

const PROBE_REASON_CODES = new Set([
  "checkout_unavailable",
  "checkout_revision_mismatch",
  "checkout_revision_unverifiable",
  "checkout_modified",
  "dependencies_unavailable",
]);

function probeReason(response: InstitutionalRunnerResponse): string | undefined {
  if (response.status === "ready") return "ready";
  return response.reasonCode && PROBE_REASON_CODES.has(response.reasonCode)
    ? response.reasonCode
    : "probe_unavailable";
}

function acquireReason(status: InstitutionalRunnerResponse["status"]): string {
  switch (status) {
    case "action_required": return "login_required";
    case "not_entitled": return "not_entitled";
    case "unsupported": return "unsupported_publisher";
    case "failed": return "institutional_attempt_failed";
    case "acquired": return "acquired";
    case "ready":
    case "unavailable": return "invalid_acquire_response";
  }
}

export async function probeInstitutional(config: ResolvedConfig, runner: InstitutionalRunner = new ProcessInstitutionalRunner()): Promise<InstitutionalProbeResult> {
  if (!config.institutional.enabled) return { status: "disabled", message: "Institutional browser acquisition is disabled." };
  if (!config.institutional.pythonExecutable || !config.institutional.checkoutRoot) {
    return { status: "unconfigured", message: "Configure an absolute Python executable and the pinned InstSci checkout in the conventional user config." };
  }
  try {
    const response = await runner.run(createInstitutionalRequest("probe"), config);
    return response.status === "ready"
      ? { status: "ready", reasonCode: probeReason(response), message: "The pinned institutional sidecar and its prerequisites are ready." }
      : { status: "unavailable", reasonCode: probeReason(response), message: "Institutional sidecar prerequisites are unavailable; verify the pinned checkout and its local dependencies." };
  } catch {
    return { status: "unavailable", reasonCode: "probe_failed", message: "Institutional sidecar probe failed; verify the configured Python executable, checkout revision, and dependencies." };
  }
}

export async function showInstitutionalJob(config: ResolvedConfig, id: string): Promise<InstitutionalJobView | null> {
  const job = await readInstitutionalJob(institutionalJobRoot(config), id);
  return job ? view(job) : null;
}

export async function statusInstitutionalJobs(config: ResolvedConfig): Promise<InstitutionalJobView[]> {
  return (await listInstitutionalJobs(institutionalJobRoot(config))).map(view);
}

export async function cancelInstitutionalJob(config: ResolvedConfig, id: string): Promise<InstitutionalJobView> {
  const root = institutionalJobRoot(config);
  return await withInstitutionalJobLock(root, id, async (job, save) => {
    assertPinnedContext(config, job);
    if (job.status === "running") throw new Error("A running institutional job cannot be canceled.");
    if (job.status === "acquired") throw new Error("An acquired institutional job cannot be canceled.");
    const next: InstitutionalJob = { ...job, status: "canceled", updatedAt: new Date().toISOString(), reasonCode: "canceled", message: "Canceled locally before acquisition." };
    await save(next);
    return view(next);
  });
}

export async function continueInstitutionalJob(options: {
  config: ResolvedConfig;
  id: string;
  runner?: InstitutionalRunner;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  agentAssisted?: boolean;
  grantId?: string;
  now?: Date;
  /** Test-only crash seam after durable artifact/Zotero commit and before terminal job save. */
  afterArtifactCommit?: () => Promise<void> | void;
}): Promise<{ job: InstitutionalJobView; artifact?: ArtifactDownloadResultEnvelope }> {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!options.agentAssisted && (!stdinIsTTY || !stdoutIsTTY)) throw new Error("Institutional continuation requires a local interactive TTY and visible desktop.");
  if (!options.agentAssisted && options.grantId) throw new Error("--grant is valid only with --agent-assisted.");
  assertConfigured(options.config);
  const root = institutionalJobRoot(options.config);
  const runner = options.runner ?? new ProcessInstitutionalRunner();
  return await withInstitutionalJobLock(root, options.id, async (job, save) => {
    assertPinnedContext(options.config, job);
    if (["acquired", "not_entitled", "unsupported", "canceled"].includes(job.status)) {
      throw new Error(`Institutional job cannot continue from terminal status ${job.status}.`);
    }
    const attemptNumber = job.attemptCount + 1;
    if (options.agentAssisted) {
      const policy = options.config.institutional.agentControl;
      if (policy.mode === "off") {
        throw new Error("Institutional agent-assisted continuation is disabled by user policy.");
      }
      if (policy.mode === "allow") {
        if (options.grantId) throw new Error("An agent grant is not used when the profile is durably allowed.");
        if (!policy.allowedProfiles.includes(job.profileId)) {
          throw new Error(`Institutional profile ${job.profileId} is not in the durable agent allowlist.`);
        }
      } else {
        if (!options.grantId) {
          throw new Error("Institutional agent policy is ask; issue and pass a one-attempt --grant after user approval.");
        }
        await consumeInstitutionalAgentGrant({
          config: options.config,
          grantId: options.grantId,
          job,
          attemptNumber,
          now: options.now,
        });
      }
    }
    const running: InstitutionalJob = {
      ...job,
      status: "running",
      updatedAt: new Date().toISOString(),
      attemptCount: attemptNumber,
      reasonCode: job.status === "running" ? "recovering_interrupted_attempt" : undefined,
      message: undefined,
    };
    await save(running);
    const attemptRoot = path.join(path.dirname(root), "attempts", job.id, randomUUID());
    await mkdir(attemptRoot, { recursive: true });
    const attemptStat = await lstat(attemptRoot);
    if (!attemptStat.isDirectory() || attemptStat.isSymbolicLink()) throw new Error("Institutional attempt root is not a regular directory.");
    try {
      let response: InstitutionalRunnerResponse;
      try {
        response = await runner.run(createInstitutionalRequest("acquire", {
          doi: job.doi,
          profileId: job.profileId,
          handoffRoot: attemptRoot,
          maxPdfBytes: options.config.institutional.maxPdfBytes,
        }), options.config);
      } catch {
        const failed: InstitutionalJob = { ...running, status: "failed", updatedAt: new Date().toISOString(), reasonCode: "sidecar_failed", message: "The institutional sidecar failed or timed out without a valid response." };
        await save(failed);
        return { job: view(failed) };
      }
      if (response.status === "acquired") {
        let attemptState = running;
        try {
          const bytes = await verifyInstitutionalHandoff({ root: attemptRoot, response, maxPdfBytes: options.config.institutional.maxPdfBytes });
          const committing: InstitutionalJob = running.commit.startedAt
            ? running
            : { ...running, commit: { ...running.commit, startedAt: new Date().toISOString() } };
          attemptState = committing;
          if (committing !== running) await save(committing);
          const artifact = await commitInstitutionalArtifact({
            config: options.config,
            doi: job.doi,
            bytes,
            attachTo: job.attachTo,
            artifactId: job.commit.artifactId,
            institutionalJobId: job.id,
            filename: job.commit.filename,
            createdAt: committing.commit.startedAt!,
          });
          if (!artifact.ok || !artifact.data) {
            const failed: InstitutionalJob = { ...committing, status: "failed", updatedAt: new Date().toISOString(), reasonCode: "artifact_commit_failed", message: "Verified bytes were placed in artifact storage, but workspace selection or metadata commit failed." };
            await save(failed);
            return { job: view(failed), artifact };
          }
          await options.afterArtifactCommit?.();
          const acquired: InstitutionalJob = { ...committing, status: "acquired", updatedAt: new Date().toISOString(), reasonCode: "acquired", message: "Verified PDF committed to Paper Search artifact storage.", artifactId: job.commit.artifactId };
          await save(acquired);
          return { job: view(acquired), artifact };
        } catch {
          const failed: InstitutionalJob = { ...attemptState, status: "failed", updatedAt: new Date().toISOString(), reasonCode: "handoff_rejected", message: "The sidecar handoff failed host PDF integrity or artifact commit checks." };
          await save(failed);
          return { job: view(failed) };
        }
      }
      const status: InstitutionalJobStatus = response.status === "ready" || response.status === "unavailable" ? "failed" : response.status;
      const next: InstitutionalJob = {
        ...running,
        status,
        updatedAt: new Date().toISOString(),
        reasonCode: acquireReason(response.status),
        message: terminalMessage(response.status),
      };
      await save(next);
      return { job: view(next) };
    } finally {
      await rm(attemptRoot, { recursive: true, force: true });
    }
  });
}
