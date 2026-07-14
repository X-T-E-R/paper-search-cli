import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunStoreError,
  openResearchRunStore,
  validateResearchRunRecord,
  type ResearchRunStore,
} from "../../src/runs/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function storeAt(
  root: string,
  options: { now?: () => Date; maxAgeDays?: number } = {},
): Promise<ResearchRunStore> {
  return openResearchRunStore({
    root: path.join(root, "runs"),
    maxAgeDays: options.maxAgeDays ?? -1,
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("durable run store", () => {
  it("creates, recursively redacts, and terminally finalizes one bounded atomic record", async () => {
    const root = await tempRoot("paper-search-runs-create-");
    const store = await storeAt(root);
    const created = await store.create({
      kind: "tool",
      request: {
        query: "graph RAG",
        apiKey: "request-secret",
        authors: ["Ada"],
        endpoint: "https://alice:pw@example.test/search?token=url-secret&query=safe",
        nested: { headers: { Authorization: "Bearer header-secret" } },
      },
      resolvedSelection: { requested: { sources: ["openalex"] } },
      build: { cliVersion: "1.2.3" },
    });

    const finished = await store.finish(created.runId, {
      status: "failed",
      result: {
        ok: false,
        errors: ["authorization=diagnostic-secret"],
        tokenCount: 42,
      },
      appendDiagnostics: [{ stderr: "must never persist", message: "Bearer another-secret" }],
    });

    expect(finished.status).toBe("failed");
    expect(finished.finishedAt).toBeTypeOf("string");
    expect(finished.request).toMatchObject({
      apiKey: "[redacted]",
      authors: ["Ada"],
      endpoint: expect.stringContaining("query=safe"),
      nested: { headers: { Authorization: "[redacted]" } },
    });
    expect(finished.result).toMatchObject({ tokenCount: 42 });
    const raw = await readFile(path.join(store.root, `${created.runId}.json`), "utf8");
    for (const secret of [
      "request-secret",
      "url-secret",
      "header-secret",
      "diagnostic-secret",
      "must never persist",
      "another-secret",
      "alice",
      "pw",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(validateResearchRunRecord(JSON.parse(raw))).toMatchObject({ runId: created.runId });

    if (process.platform !== "win32") {
      expect((await lstat(store.root)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(store.root, `${created.runId}.json`))).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent progress mutations without changing immutable identity", async () => {
    const root = await tempRoot("paper-search-runs-concurrent-");
    const store = await storeAt(root);
    const created = await store.create({
      kind: "citation",
      request: { seed: "doi:10.1/example" },
      resolvedSelection: { providers: ["semantic-scholar"] },
      build: { cliVersion: "1.0.0" },
    });

    let peer = store;
    const alias = path.join(root, "shared-runs-alias");
    try {
      await symlink(store.root, alias, process.platform === "win32" ? "junction" : "dir");
      peer = await openResearchRunStore({ root: alias, maxAgeDays: -1 });
      expect(peer.root).toBe(store.root);
      expect(peer.lockRoot).toBe(store.lockRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? store : peer).updateProgress(created.runId, { appendAttempts: [{ index }] })));
    const updated = await store.read(created.runId);

    expect(updated.request).toEqual(created.request);
    expect(updated.resolvedSelection).toEqual(created.resolvedSelection);
    expect(updated.startedAt).toBe(created.startedAt);
    expect(updated.attempts).toHaveLength(20);
    expect(new Set(updated.attempts.map((entry) => (entry as { index: number }).index)).size).toBe(20);
  });

  it("keeps plan-only pruning write-free and -1 selects nothing", async () => {
    const root = await tempRoot("paper-search-runs-plan-");
    const runRoot = path.join(root, "not-created", "runs");
    const store = await openResearchRunStore({ root: runRoot, maxAgeDays: -1 });
    const plan = await store.prune();

    expect(plan).toMatchObject({ planned: true, maxAgeDays: -1, candidates: [] });
    await expect(access(runRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes only old terminal unpinned records and retains active, corrupt, and resumable runs", async () => {
    const root = await tempRoot("paper-search-runs-prune-");
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = await storeAt(root, { now: () => now, maxAgeDays: 7 });
    const create = (kind: "tool" | "citation" = "tool") => store.create({
      kind,
      request: { query: "bounded" },
      build: { cliVersion: "1.0.0" },
    });

    const eligible = await create();
    await store.finish(eligible.runId, { status: "failed", result: { ok: false } });
    const pinned = await create();
    await store.finish(pinned.runId, { status: "completed", result: { ok: true } });
    await store.setPinned(pinned.runId, true);
    const active = await create();
    const resumable = await create("citation");
    await store.updateProgress(resumable.runId, { checkpoint: { cursor: "next" } });
    await store.finish(resumable.runId, { status: "interrupted" });
    await writeFile(path.join(store.root, "corrupt.json"), "{not-json", { mode: 0o600 });

    now = new Date("2026-02-01T00:00:00.000Z");
    const plan = await store.prune();
    expect(plan.planned).toBe(true);
    if (!plan.planned) throw new Error("expected prune plan");
    expect(plan.candidates.map((entry) => entry.runId)).toEqual([eligible.runId]);
    expect(plan.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: pinned.runId, reason: "pinned" }),
      expect.objectContaining({ runId: active.runId, reason: "active" }),
      expect.objectContaining({ runId: resumable.runId, reason: "resumable" }),
      expect.objectContaining({ runId: "corrupt", reason: "corrupt" }),
    ]));

    const applied = await store.prune({ apply: true });
    expect(applied.planned).toBe(false);
    if (applied.planned) throw new Error("expected applied prune");
    expect(applied.deleted.map((entry) => entry.runId)).toEqual([eligible.runId]);
    await expect(store.read(eligible.runId)).rejects.toMatchObject({ code: "run_not_found" });
    await expect(store.read(pinned.runId)).resolves.toMatchObject({ pinned: true });
    await expect(store.read(active.runId)).resolves.toMatchObject({ status: "running" });
    await expect(store.read(resumable.runId)).resolves.toMatchObject({ status: "interrupted" });
  });

  it("does not follow a symlink record during list or prune", async () => {
    const root = await tempRoot("paper-search-runs-symlink-");
    const store = await storeAt(root);
    const created = await store.create({
      kind: "tool",
      request: {},
      build: { cliVersion: "1.0.0" },
    });
    await store.finish(created.runId, { status: "completed" });
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify(await store.read(created.runId)), "utf8");
    const linkPath = path.join(store.root, "linked.json");
    try {
      await symlink(outside, linkPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const listed = await store.list();
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "linked", status: "corrupt" }),
    ]));
    await store.prune({ apply: true, maxAgeDays: 1, now: new Date("2100-01-01T00:00:00.000Z") });
    await expect(access(outside)).resolves.toBeUndefined();
    expect(await readFile(linkPath, "utf8")).toContain(created.runId);
  });

  it("exports atomically to the explicit path and refuses overwrite", async () => {
    const root = await tempRoot("paper-search-runs-export-");
    const store = await storeAt(root);
    const created = await store.create({
      kind: "assessment",
      request: { identifier: "doi:10.1/example" },
      build: { cliVersion: "1.0.0" },
    });
    await store.finish(created.runId, { status: "completed", result: { observations: [] } });
    const output = path.join(root, "explicit", "run-export.json");

    await expect(store.export(created.runId, output)).resolves.toMatchObject({ path: output });
    await expect(store.export(created.runId, output)).rejects.toMatchObject({
      code: "run_export_exists",
    });
  });

  it("reopens interrupted, partial, or failed checkpointed runs while preserving prior evidence", async () => {
    const root = await tempRoot("paper-search-runs-resume-");
    const store = await storeAt(root);
    for (const status of ["interrupted", "partial", "failed"] as const) {
      const created = await store.create({
        kind: "citation",
        request: { seed: "doi:10.1/example" },
        build: { cliVersion: "1.0.0" },
        provenance: [{ provider: "semantic-scholar" }],
      });
      await store.updateProgress(created.runId, { checkpoint: { cursor: `cursor-${status}` } });
      await store.finish(created.runId, { status, result: { prior: status } });

      const reopened = await store.resume(created.runId);
      expect(reopened).toMatchObject({
        status: "running",
        checkpoint: { cursor: `cursor-${status}` },
        result: { prior: status },
        provenance: [{ provider: "semantic-scholar" }],
      });
      expect(reopened.finishedAt).toBeUndefined();
      expect(reopened.attempts.at(-1)).toMatchObject({
        kind: "run.reopened",
        previousStatus: status,
        reopenedAt: expect.any(String),
      });
    }

    const completed = await store.create({
      kind: "citation",
      request: {},
      build: { cliVersion: "1.0.0" },
    });
    await store.updateProgress(completed.runId, { checkpoint: { cursor: "kept-for-audit" } });
    await store.finish(completed.runId, { status: "completed", result: { ok: true } });
    await expect(store.resume(completed.runId)).rejects.toMatchObject({ code: "run_conflict" });

    const noCheckpoint = await store.create({
      kind: "citation",
      request: {},
      build: { cliVersion: "1.0.0" },
    });
    await store.finish(noCheckpoint.runId, { status: "failed" });
    await expect(store.resume(noCheckpoint.runId)).rejects.toMatchObject({ code: "run_conflict" });
  });

  it("fails closed on nonterminal timestamps, oversized records, and unsafe ids", async () => {
    const root = await tempRoot("paper-search-runs-invalid-");
    const store = await storeAt(root);
    await expect(store.create({
      runId: "../escape",
      kind: "tool",
      request: {},
      build: { cliVersion: "1.0.0" },
    })).rejects.toBeInstanceOf(RunStoreError);
    await expect(store.create({
      kind: "tool",
      request: { values: Array.from({ length: 220_000 }, (_, index) => index) },
      build: { cliVersion: "1.0.0" },
    })).rejects.toMatchObject({ code: "invalid_run_record" });
    expect(() => validateResearchRunRecord({
      schemaVersion: 1,
      runId: "valid-id",
      kind: "tool",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
      request: {},
      build: { cliVersion: "1.0.0" },
      provenance: [],
      attempts: [],
      diagnostics: [],
    })).toThrow(/finishedAt/);
  });
});
