import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { createInstitutionalJob, institutionalJobRoot, readInstitutionalJob } from "../../src/institutional/jobStore.js";
import { INSTSCI_ADAPTER_ID, INSTSCI_CAPTURE_REVISION, parseInstitutionalResponse, type InstitutionalRunnerResponse } from "../../src/institutional/protocol.js";
import { verifyInstitutionalHandoff, type InstitutionalRunner } from "../../src/institutional/runner.js";
import { cancelInstitutionalJob, continueInstitutionalJob, probeInstitutional, showInstitutionalJob } from "../../src/institutional/service.js";
import { listArtifactRecords } from "../../src/material/artifactStore.js";
import { planArtifactDownload, runArtifactDownloadWithInstitutionalFallback } from "../../src/material/artifactDownload.js";
import { runCanonicalTool } from "../../src/surface/toolRunner.js";
import {
  institutionalAgentGrantRoot,
  issueInstitutionalAgentGrant,
  readInstitutionalAgentGrantForTest,
  revokeInstitutionalAgentGrants,
  setInstitutionalAgentPolicy,
} from "../../src/institutional/agentAuth.js";
import { readUserConfigFile } from "../../src/config/userConfig.js";
import { buildProgram } from "../../src/program.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(enabled = true): Promise<{ root: string; config: ResolvedConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-institutional-"));
  roots.push(root);
  const config: ResolvedConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    context: { id: "fixture", kind: "standalone" },
    workspace: { ...structuredClone(DEFAULT_CONFIG.workspace), root: path.join(root, "workspace") },
    storage: {
      artifactRoot: path.join(root, "artifacts"),
      extractionRoot: path.join(root, "extractions"),
      exportRoot: path.join(root, "exports"),
    },
    institutional: {
      ...structuredClone(DEFAULT_CONFIG.institutional),
      enabled,
      pythonExecutable: process.execPath,
      checkoutRoot: root,
      maxPdfBytes: 1024,
    },
    meta: {
      cwd: root,
      userConfigPath: path.join(root, "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
  return { root, config };
}

class FakeRunner implements InstitutionalRunner {
  calls = 0;
  constructor(
    private readonly status: InstitutionalRunnerResponse["status"],
    private readonly writer?: (root: string) => Promise<InstitutionalRunnerResponse["handoff"]>,
    private readonly reasonCode?: string,
  ) {}
  async run(request: Parameters<InstitutionalRunner["run"]>[0]): Promise<InstitutionalRunnerResponse> {
    this.calls += 1;
    const handoff = request.handoffRoot && this.writer ? await this.writer(request.handoffRoot) : undefined;
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      adapter: { id: INSTSCI_ADAPTER_ID, revision: INSTSCI_CAPTURE_REVISION },
      status: this.status,
      ...(this.status === "action_required" ? { reasonCode: this.reasonCode ?? "login_required", message: "cookie=secret signedUrl=https://secret" } : {}),
      ...(this.status !== "action_required" && this.reasonCode ? { reasonCode: this.reasonCode } : {}),
      ...(handoff ? { handoff } : {}),
    };
  }
}

async function pdfWriter(root: string): Promise<{ relativePath: string; sizeBytes: number; sha256: string }> {
  const bytes = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
  const relativePath = "handoff/paper.pdf";
  await mkdir(path.join(root, "handoff"), { recursive: true });
  await writeFile(path.join(root, relativePath), bytes);
  return { relativePath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("institutional browser sidecar host", () => {
  it("registers policy, grant, and agent-assisted controls only on the local CLI tree", () => {
    const institutional = buildProgram().commands.find((command) => command.name() === "institutional");
    expect(institutional).toBeDefined();
    expect(institutional!.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      "agent-policy", "agent-grant", "continue",
    ]));
    const continuation = institutional!.commands.find((command) => command.name() === "continue");
    expect(continuation!.options.map((option) => option.long)).toEqual(expect.arrayContaining(["--agent-assisted", "--grant"]));
  });

  it("creates one credential-free continuation only after ordinary DOI acquisition fails", async () => {
    const { config } = await fixture();
    const envelope = await runArtifactDownloadWithInstitutionalFallback({
      config,
      input: "10.1021/example",
      institutional: true,
    });
    expect(envelope).toMatchObject({
      ok: false,
      state: "action_required",
      actions: [{ kind: "continue_institutional", target: { kind: "institutional_job", id: expect.any(String) } }],
    });
    const serialized = JSON.stringify(envelope.actions);
    expect(serialized).not.toMatch(/cookie|password|token|profile.*path|checkout/i);
    expect((await statusInstitutionalJobsForTest(config))).toHaveLength(1);
  });

  it("lets canonical/MCP-equivalent calls create and inspect, but exposes no continue tool", async () => {
    const { config } = await fixture();
    const created = await runCanonicalTool(config, "artifact_download", { input: "10.1021/example", institutional: true });
    expect(created).toMatchObject({ state: "action_required", actions: [{ kind: "continue_institutional" }] });
    const jobId = created.actions![0]!.target.id;
    const shown = await runCanonicalTool(config, "institutional_job_show", { jobId });
    expect(shown).toMatchObject({ ok: true, data: { job: { id: jobId, status: "queued" } } });
    const rejected = await runCanonicalTool(config, "institutional_continue", { jobId });
    expect(rejected).toMatchObject({ ok: false, diagnostics: { reason: "unknown_tool" } });
    const authorityInjection = await runCanonicalTool(config, "artifact_download", {
      input: "10.1021/example",
      institutional: true,
      agentAssisted: true,
      grant: "not-authority",
    });
    expect(authorityInjection).toMatchObject({ ok: false, diagnostics: { reason: "invalid_arguments" } });
  });

  it("does not create a job when the feature is disabled", async () => {
    const { config } = await fixture(false);
    await expect(runArtifactDownloadWithInstitutionalFallback({ config, input: "10.1021/example", institutional: true }))
      .rejects.toThrow(/disabled/);
    expect((await statusInstitutionalJobsForTest(config))).toHaveLength(0);
  });

  it("keeps dry-run planning job-free", async () => {
    const { config } = await fixture();
    await expect(planArtifactDownload({ config, input: "10.1021/example", institutional: true })).rejects.toThrow();
    expect((await statusInstitutionalJobsForTest(config))).toHaveLength(0);
  });

  it("does not invoke a runner when disabled or when continue is non-TTY", async () => {
    const { config } = await fixture(false);
    const runner = new FakeRunner("ready");
    expect(await probeInstitutional(config, runner)).toMatchObject({ status: "disabled" });
    expect(runner.calls).toBe(0);
    const enabled = { ...config, institutional: { ...config.institutional, enabled: true } };
    const job = await createInstitutionalJob(enabled, { doi: "10.1021/example" });
    await expect(continueInstitutionalJob({ config: enabled, id: job.id, runner, stdinIsTTY: false, stdoutIsTTY: true })).rejects.toThrow(/interactive TTY/);
    expect(runner.calls).toBe(0);
  });

  it("does not invoke a runner when unconfigured", async () => {
    const { config } = await fixture();
    config.institutional.pythonExecutable = "";
    const runner = new FakeRunner("ready");
    expect(await probeInstitutional(config, runner)).toMatchObject({ status: "unconfigured" });
    expect(runner.calls).toBe(0);
  });

  it("fails closed on runner crash or timeout without persisting raw diagnostics", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const runner: InstitutionalRunner = { async run() { throw new Error("cookie=secret raw stderr"); } };
    const result = await continueInstitutionalJob({ config, id: job.id, runner, stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.job).toMatchObject({ status: "failed", reasonCode: "sidecar_failed" });
    expect(JSON.stringify(await readInstitutionalJob(institutionalJobRoot(config), job.id))).not.toMatch(/cookie=secret|raw stderr/);
  });

  it("recovers an interrupted running attempt while cancel still refuses running state", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example" });
    const running = { ...job, status: "running" as const, updatedAt: new Date().toISOString(), attemptCount: 1 };
    await writeFile(path.join(institutionalJobRoot(config), `${job.id}.json`), `${JSON.stringify(running)}\n`);
    await expect(cancelInstitutionalJob(config, job.id)).rejects.toThrow(/running.*cannot be canceled/i);
    const result = await continueInstitutionalJob({ config, id: job.id, runner: new FakeRunner("action_required"), stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.job).toMatchObject({ status: "action_required", attemptCount: 2 });
  });

  it("rejects protocol and revision mismatch", () => {
    const request = {
      protocolVersion: 1 as const,
      requestId: "request-1",
      operation: "probe" as const,
      adapter: { id: INSTSCI_ADAPTER_ID, revision: INSTSCI_CAPTURE_REVISION },
    };
    expect(() => parseInstitutionalResponse({
      protocolVersion: 2,
      requestId: "request-1",
      adapter: request.adapter,
      status: "ready",
    }, request)).toThrow(/protocol version mismatch/);
    expect(() => parseInstitutionalResponse({
      protocolVersion: 1,
      requestId: "request-1",
      adapter: { id: INSTSCI_ADAPTER_ID, revision: "wrong" },
      status: "ready",
    }, request)).toThrow(/revision mismatch/);
  });

  it("persists only sanitized action-required state and exposes no pinned roots", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const runner = new FakeRunner("action_required");
    const result = await continueInstitutionalJob({ config, id: job.id, runner, stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.job).toMatchObject({ status: "action_required", reasonCode: "login_required" });
    expect(JSON.stringify(result.job)).not.toMatch(/cookie|signedUrl|workspaceRoot|artifactRoot|checkout/i);
    expect(JSON.stringify(await readInstitutionalJob(institutionalJobRoot(config), job.id))).not.toMatch(/cookie=secret|signedUrl/);
  });

  it("commits an acquired PDF through the normal artifact and selection stores", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const result = await continueInstitutionalJob({ config, id: job.id, runner: new FakeRunner("acquired", pdfWriter), stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.job).toMatchObject({ status: "acquired", artifactId: expect.any(String) });
    const artifacts = await listArtifactRecords(config.workspace.root);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "pdf", status: "downloaded", provenance: { providerId: "institutional-browser" } });
    expect(JSON.stringify(artifacts[0])).not.toMatch(/campus|cookie|profile|signed/i);
    expect(await readFile(path.join(config.storage.artifactRoot, artifacts[0]!.storage!.key), "utf8")).toContain("%PDF-");
  });

  it("reconciles the stable artifact and Zotero receipt after a post-commit crash", async () => {
    const { config } = await fixture();
    config.zoteroBinding = {
      mode: "bound",
      collectionKeys: ["ABC123"],
      attachmentMode: "link",
      markdownMode: "none",
    };
    const job = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const first = await continueInstitutionalJob({
      config,
      id: job.id,
      runner: new FakeRunner("acquired", pdfWriter),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      afterArtifactCommit() { throw new Error("deterministic crash after durable commit"); },
    });
    expect(first.job).toMatchObject({ status: "failed", reasonCode: "handoff_rejected" });
    expect(await listArtifactRecords(config.workspace.root)).toHaveLength(1);
    const receiptRoot = path.join(config.workspace.root, "zotero", "receipts");
    expect((await readdir(receiptRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const second = await continueInstitutionalJob({
      config,
      id: job.id,
      runner: new FakeRunner("acquired", pdfWriter),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(second.job).toMatchObject({ status: "acquired", artifactId: job.commit.artifactId });
    expect(await listArtifactRecords(config.workspace.root)).toHaveLength(1);
    expect((await readdir(receiptRoot)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("does not reuse another institutional artifact receipt for the same DOI item", async () => {
    const { config } = await fixture();
    config.zoteroBinding = {
      mode: "bound",
      collectionKeys: ["ABC123"],
      attachmentMode: "link",
      markdownMode: "none",
    };
    const firstJob = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const first = await continueInstitutionalJob({
      config,
      id: firstJob.id,
      runner: new FakeRunner("acquired", pdfWriter),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(first.job.status).toBe("acquired");

    const secondJob = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const second = await continueInstitutionalJob({
      config,
      id: secondJob.id,
      runner: new FakeRunner("acquired", pdfWriter),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(second.job).toMatchObject({ status: "acquired", artifactId: secondJob.commit.artifactId });
    expect(await listArtifactRecords(config.workspace.root)).toHaveLength(2);
    const receiptRoot = path.join(config.workspace.root, "zotero", "receipts");
    const receipts = await Promise.all((await readdir(receiptRoot))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(path.join(receiptRoot, name), "utf8")) as Record<string, unknown>));
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.projectionCorrelation)).toEqual(expect.arrayContaining([
      expect.objectContaining({ institutionalJobId: firstJob.id, artifactId: firstJob.commit.artifactId }),
      expect.objectContaining({ institutionalJobId: secondJob.id, artifactId: secondJob.commit.artifactId }),
    ]));
  });

  it("maps arbitrary adapter reason codes to host-owned values", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example" });
    const result = await continueInstitutionalJob({
      config,
      id: job.id,
      runner: new FakeRunner("failed", undefined, "cookie_theft_success"),
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(result.job).toMatchObject({ status: "failed", reasonCode: "institutional_attempt_failed" });
    expect(JSON.stringify(await readInstitutionalJob(institutionalJobRoot(config), job.id))).not.toContain("cookie_theft_success");
  });

  it.each(["not_entitled", "unsupported", "failed"] as const)("maps %s without retaining adapter diagnostics", async (status) => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example" });
    const result = await continueInstitutionalJob({ config, id: job.id, runner: new FakeRunner(status), stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.job.status).toBe(status);
    expect(JSON.stringify(result.job)).not.toContain("secret");
  });

  it("rejects context drift before spawning", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example" });
    const runner = new FakeRunner("action_required");
    const drifted = { ...config, workspace: { ...config.workspace, root: path.join(config.meta.cwd, "other") } };
    await expect(continueInstitutionalJob({ config: drifted, id: job.id, runner, stdinIsTTY: true, stdoutIsTTY: true })).rejects.toThrow(/context drift/);
    expect(runner.calls).toBe(0);
  });

  it("returns a safe read projection for canonical/MCP inspection", async () => {
    const { config } = await fixture();
    const job = await createInstitutionalJob(config, { doi: "10.1021/example" });
    const shown = await showInstitutionalJob(config, job.id);
    expect(shown).toMatchObject({ id: job.id, status: "queued", continueCommand: expect.any(String) });
    expect(shown).not.toHaveProperty("roots");
  });

  it("persists user-level agent policy and requires an explicit allowlisted profile", async () => {
    const { config } = await fixture();
    await writeFile(config.meta.userConfigPath, "schemaVersion = 1\n", "utf8");
    await expect(setInstitutionalAgentPolicy({ config, mode: "allow" })).rejects.toThrow(/explicit --profile/);
    const policy = await setInstitutionalAgentPolicy({ config, mode: "allow", profileId: "campus" });
    expect(policy).toEqual({ mode: "allow", allowedProfiles: ["campus"] });
    expect((await readUserConfigFile(config.meta.userConfigPath)).data.institutional?.agentControl)
      .toEqual({ mode: "allow", allowedProfiles: ["campus"] });
  });

  it("consumes an ask-mode grant before a non-TTY attempt and rejects replay", async () => {
    const { config } = await fixture();
    config.institutional.agentControl = { mode: "ask", allowedProfiles: [] };
    const job = await createInstitutionalJob(config, { doi: "10.1021/example", profileId: "campus" });
    const grant = await issueInstitutionalAgentGrant({ config, jobId: job.id, ttlSeconds: 60 });
    const runner = new FakeRunner("action_required");
    const first = await continueInstitutionalJob({
      config,
      id: job.id,
      runner,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      agentAssisted: true,
      grantId: grant.id,
    });
    expect(first.job).toMatchObject({ status: "action_required", attemptCount: 1 });
    expect((await readInstitutionalAgentGrantForTest(config, grant.id))?.status).toBe("consumed");
    await expect(continueInstitutionalJob({
      config,
      id: job.id,
      runner,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      agentAssisted: true,
      grantId: grant.id,
    })).rejects.toThrow(/consumed|replayed/);
    expect(runner.calls).toBe(1);
  });

  it("rejects expired, revoked, and profile-mismatched agent authority", async () => {
    const { config } = await fixture();
    config.institutional.agentControl = { mode: "ask", allowedProfiles: [] };
    const expiredJob = await createInstitutionalJob(config, { doi: "10.1021/expired", profileId: "campus" });
    const expired = await issueInstitutionalAgentGrant({ config, jobId: expiredJob.id, ttlSeconds: 1, now: new Date("2026-01-01T00:00:00.000Z") });
    await expect(continueInstitutionalJob({
      config, id: expiredJob.id, runner: new FakeRunner("action_required"), agentAssisted: true,
      grantId: expired.id, stdinIsTTY: false, stdoutIsTTY: false, now: new Date("2026-01-01T00:00:02.000Z"),
    })).rejects.toThrow(/expired/);

    const revokedJob = await createInstitutionalJob(config, { doi: "10.1021/revoked", profileId: "campus" });
    const revoked = await issueInstitutionalAgentGrant({ config, jobId: revokedJob.id, ttlSeconds: 60 });
    await revokeInstitutionalAgentGrants({ config, grantId: revoked.id });
    await expect(continueInstitutionalJob({
      config, id: revokedJob.id, runner: new FakeRunner("action_required"), agentAssisted: true,
      grantId: revoked.id, stdinIsTTY: false, stdoutIsTTY: false,
    })).rejects.toThrow(/revoked/);

    config.institutional.agentControl = { mode: "allow", allowedProfiles: ["other"] };
    const mismatch = await createInstitutionalJob(config, { doi: "10.1021/mismatch", profileId: "campus" });
    await expect(continueInstitutionalJob({
      config, id: mismatch.id, runner: new FakeRunner("action_required"), agentAssisted: true,
      stdinIsTTY: false, stdoutIsTTY: false,
    })).rejects.toThrow(/allowlist/);
  });

  it("allows a durable profile without repeat grants, while off still permits human TTY", async () => {
    const { config } = await fixture();
    config.institutional.agentControl = { mode: "allow", allowedProfiles: ["campus"] };
    const allowed = await createInstitutionalJob(config, { doi: "10.1021/allowed", profileId: "campus" });
    const agentRunner = new FakeRunner("action_required");
    const assisted = await continueInstitutionalJob({
      config, id: allowed.id, runner: agentRunner, agentAssisted: true, stdinIsTTY: false, stdoutIsTTY: false,
    });
    expect(assisted.job.status).toBe("action_required");

    config.institutional.agentControl = { mode: "off", allowedProfiles: [] };
    const blocked = await createInstitutionalJob(config, { doi: "10.1021/blocked", profileId: "campus" });
    const blockedRunner = new FakeRunner("action_required");
    await expect(continueInstitutionalJob({
      config, id: blocked.id, runner: blockedRunner, agentAssisted: true, stdinIsTTY: false, stdoutIsTTY: false,
    })).rejects.toThrow(/disabled by user policy/);
    expect(blockedRunner.calls).toBe(0);
    const human = await continueInstitutionalJob({
      config, id: blocked.id, runner: blockedRunner, stdinIsTTY: true, stdoutIsTTY: true,
    });
    expect(human.job.status).toBe("action_required");
    expect(blockedRunner.calls).toBe(1);
  });

  it("keeps grant receipts private and free of user wording or browser data", async () => {
    const { config } = await fixture();
    config.institutional.agentControl = { mode: "ask", allowedProfiles: [] };
    const job = await createInstitutionalJob(config, { doi: "10.1021/safe", profileId: "campus" });
    const grant = await issueInstitutionalAgentGrant({ config, jobId: job.id, ttlSeconds: 60 });
    const raw = await readFile(path.join(institutionalAgentGrantRoot(config), `${grant.id}.json`), "utf8");
    expect(raw).not.toMatch(/cookie|password|signed.?url|prompt|user.?wording|browser.?path/i);
    expect(JSON.parse(raw)).not.toHaveProperty("message");
  });
});

async function statusInstitutionalJobsForTest(config: ResolvedConfig) {
  const { statusInstitutionalJobs } = await import("../../src/institutional/service.js");
  return statusInstitutionalJobs(config);
}

describe("institutional handoff validation", () => {
  async function response(root: string, handoff: InstitutionalRunnerResponse["handoff"]): Promise<Buffer> {
    return verifyInstitutionalHandoff({ root, maxPdfBytes: 64, response: {
      protocolVersion: 1,
      requestId: "fixture",
      adapter: { id: INSTSCI_ADAPTER_ID, revision: INSTSCI_CAPTURE_REVISION },
      status: "acquired",
      handoff,
    } });
  }

  it("rejects path escape, non-PDF, oversize, and digest mismatch", async () => {
    const { root } = await fixture();
    const handoffRoot = path.join(root, "handoff");
    await mkdir(handoffRoot);
    await expect(response(handoffRoot, { relativePath: "../escape.pdf", sizeBytes: 1, sha256: "0".repeat(64) })).rejects.toThrow(/contained/);
    await writeFile(path.join(handoffRoot, "bad.pdf"), "not-pdf");
    await expect(response(handoffRoot, { relativePath: "bad.pdf", sizeBytes: 7, sha256: createHash("sha256").update("not-pdf").digest("hex") })).rejects.toThrow(/not a PDF/);
    const large = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(100)]);
    await writeFile(path.join(handoffRoot, "large.pdf"), large);
    await expect(response(handoffRoot, { relativePath: "large.pdf", sizeBytes: large.length, sha256: createHash("sha256").update(large).digest("hex") })).rejects.toThrow(/exceeds/);
    const valid = Buffer.from("%PDF-valid");
    await writeFile(path.join(handoffRoot, "digest.pdf"), valid);
    await expect(response(handoffRoot, { relativePath: "digest.pdf", sizeBytes: valid.length, sha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/);
  });

  it("rejects a symlink or Windows reparse handoff", async () => {
    const { root } = await fixture();
    const handoffRoot = path.join(root, "handoff");
    await mkdir(handoffRoot);
    const real = path.join(root, "real.pdf");
    await writeFile(real, "%PDF-real");
    const link = path.join(handoffRoot, "link.pdf");
    try { await symlink(real, link, "file"); }
    catch { return; /* Windows CI may not grant symlink creation. */ }
    await expect(response(handoffRoot, { relativePath: "link.pdf", sizeBytes: 9, sha256: createHash("sha256").update("%PDF-real").digest("hex") })).rejects.toThrow(/non-reparse/);
  });

  it("rejects a Windows junction in the handoff path", async () => {
    if (process.platform !== "win32") return;
    const { root } = await fixture();
    const handoffRoot = path.join(root, "handoff");
    const external = path.join(root, "external");
    await mkdir(handoffRoot);
    await mkdir(external);
    const bytes = Buffer.from("%PDF-junction");
    await writeFile(path.join(external, "paper.pdf"), bytes);
    try { await symlink(external, path.join(handoffRoot, "linked"), "junction"); }
    catch { return; }
    await expect(response(handoffRoot, {
      relativePath: "linked/paper.pdf",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })).rejects.toThrow(/reparse point/);
  });
});
