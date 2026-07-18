import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMaterialProviderZipInstallPlan,
  applyMaterialProviderZipInstallWithReceipt,
  planMaterialProviderZipInstall,
} from "../../src/material/install/package.js";
import { buildProgram } from "../../src/program.js";
import { inspectProviderDirectory } from "../../src/providers/inventory.js";
import {
  applyProviderUninstallPlan,
  applyProviderRollbackPlan,
  applyProviderZipLifecyclePlan,
  planProviderRollback,
  planProviderUninstall,
  planProviderZipLifecycle,
} from "../../src/providers/manualLifecycle.js";
import {
  inspectProviderReplacementPrecondition,
  type ProviderInstallReceipt,
} from "../../src/providers/install/manualZip.js";
import { assertProviderRollbackReady } from "../../src/providers/rollbackStore.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];
const fixturePath = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "fixture-extractor",
);

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeMaterialZip(
  zipPath: string,
  options: { id: string; version: string },
): Promise<void> {
  const zip = new JSZip();
  const manifest = JSON.parse(await readFile(path.join(fixturePath, "manifest.json"), "utf8"));
  zip.file(
    `${options.id}/manifest.json`,
    JSON.stringify({ ...manifest, id: options.id, name: options.id, version: options.version }),
  );
  const entries = await readdir(fixturePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === "manifest.json") continue;
    zip.file(`${options.id}/${entry.name}`, await readFile(path.join(fixturePath, entry.name)));
  }
  await writeFile(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function installBoundProvider(options: {
  zipPath: string;
  installDir: string;
  id: string;
  version: string;
}): Promise<void> {
  const plan = await planMaterialProviderZipInstall(options.zipPath, options.installDir, {
    currentVersion: "1.0.0",
  });
  const now = "2026-01-01T00:00:00.000Z";
  const receipt: ProviderInstallReceipt = {
    schemaVersion: 1,
    runtimeKind: "material",
    providerKind: plan.providerKind,
    id: options.id,
    version: options.version,
    installType: "registry",
    bound: true,
    archiveSha256: plan.archiveSha256,
    manifestSha256: plan.manifestSha256,
    entryPath: plan.entryPath,
    entrySha256: plan.entrySha256,
    installedAt: now,
    updatedAt: now,
    subscriptionId: "fixture-registry",
    sourceFingerprint: "1".repeat(64),
    canonicalSource: "https://example.test/material/registry.json",
    registryDigest: "2".repeat(64),
  };
  await applyMaterialProviderZipInstallWithReceipt({
    zipPath: options.zipPath,
    installDir: options.installDir,
    expectation: {
      id: options.id,
      version: options.version,
      kind: plan.providerKind,
      currentVersion: "1.0.0",
      registryChecksum: { sha256: plan.archiveSha256, target: "archive" },
    },
    receipt,
    replacementPrecondition: { state: "absent" },
  });
}

async function runCli(root: string, args: string[]): Promise<ResultEnvelope> {
  let stdout = "";
  let stderr = "";
  const previous = {
    cwd: process.cwd(),
    testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
    testRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    home: process.env.PAPER_SEARCH_HOME,
  };
  process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
  process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, ".test-paper-search-data");
  delete process.env.PAPER_SEARCH_HOME;
  process.chdir(root);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    })
      .exitOverride()
      .parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(previous.cwd);
    if (previous.testMode === undefined) delete process.env.PAPER_SEARCH_INSTALL_TEST_MODE;
    else process.env.PAPER_SEARCH_INSTALL_TEST_MODE = previous.testMode;
    if (previous.testRoot === undefined) delete process.env.PAPER_SEARCH_TEST_DATA_ROOT;
    else process.env.PAPER_SEARCH_TEST_DATA_ROOT = previous.testRoot;
    if (previous.home === undefined) delete process.env.PAPER_SEARCH_HOME;
    else process.env.PAPER_SEARCH_HOME = previous.home;
  }
  expect(stderr).toBe("");
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return envelope;
}

async function lifecycleEvents(root: string): Promise<Array<Record<string, unknown>>> {
  const eventsDir = path.join(root, ".test-paper-search-data", "state", "events");
  const files = await readdir(eventsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const events: Array<Record<string, unknown>> = [];
  for (const file of files.sort()) {
    const raw = await readFile(path.join(eventsDir, file), "utf8");
    events.push(
      ...raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  }
  return events;
}

describe.sequential("manual provider lifecycle commands", () => {
  it("refuses bound replacement by default, previews an explicit transition, applies it, and emits one truthful event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-zip-lifecycle-"));
    tempDirs.push(root);
    const providersRoot = path.join(root, "providers");
    const installDir = path.join(providersRoot, "material");
    await writeFile(
      path.join(root, "paper-search.toml"),
      `[providers]\ninstallDir = "${providersRoot.replace(/\\/g, "\\\\")}"\n`,
      "utf8",
    );
    const initialZip = path.join(root, "initial.zip");
    const updateZip = path.join(root, "update.zip");
    await writeMaterialZip(initialZip, { id: "bound-fixture", version: "1.0.0" });
    await writeMaterialZip(updateZip, { id: "bound-fixture", version: "1.1.0" });
    await installBoundProvider({
      zipPath: initialZip,
      installDir,
      id: "bound-fixture",
      version: "1.0.0",
    });

    const refused = await runCli(root, [
      "providers", "install-zip", updateZip, "--kind", "material", "--json",
    ]);
    expect(refused).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("subscription-bound")],
    });
    expect(await lifecycleEvents(root)).toEqual([]);

    const preview = await runCli(root, [
      "providers", "install-zip", updateZip, "--kind", "material", "--replace-bound", "--json",
    ]);
    expect(preview).toMatchObject({
      ok: true,
      planned: true,
      data: {
        plan: {
          ownershipTransition: {
            kind: "subscription-bound-to-manual-zip",
            explicit: true,
            from: {
              id: "bound-fixture",
              version: "1.0.0",
              receipt: {
                bound: true,
                subscriptionId: "fixture-registry",
              },
            },
            to: { version: "1.1.0", bound: false },
            rollbackCommand: expect.stringContaining("providers rollback bound-fixture"),
          },
        },
      },
    });
    expect((await inspectProviderDirectory("material", path.join(installDir, "bound-fixture"))).version)
      .toBe("1.0.0");
    expect(await lifecycleEvents(root)).toEqual([]);

    const applied = await runCli(root, [
      "providers", "install-zip", updateZip, "--kind", "material", "--replace-bound", "--apply", "--json",
    ]);
    expect(applied).toMatchObject({
      ok: true,
      planned: false,
      data: {
        result: {
          id: "bound-fixture",
          rollback: { revision: expect.stringMatching(/^[a-f0-9]{64}$/) },
          rollbackCommand: expect.stringContaining("providers rollback bound-fixture"),
        },
      },
    });
    const installed = await inspectProviderDirectory("material", path.join(installDir, "bound-fixture"));
    expect(installed).toMatchObject({ version: "1.1.0", healthy: true, bound: false });
    const transition = (applied.data as {
      plan: { ownershipTransition: { rollback: Parameters<typeof assertProviderRollbackReady>[0] } };
    }).plan.ownershipTransition;
    await expect(assertProviderRollbackReady(transition.rollback)).resolves.toBeUndefined();
    expect(await lifecycleEvents(root)).toEqual([
      expect.objectContaining({
        command: "providers install-zip",
        affectedIds: ["bound-fixture"],
        outcome: "applied",
      }),
    ]);

    const rollback = await runCli(root, [
      "providers", "rollback", "bound-fixture", "--kind", "material",
      "--revision", transition.rollback.revision, "--apply", "--json",
    ]);
    expect(rollback).toMatchObject({
      ok: true,
      data: {
        result: {
          restored: true,
          version: "1.0.0",
          retainedDisplaced: { version: "1.1.0" },
          redoCommand: expect.stringContaining("providers rollback bound-fixture"),
        },
      },
    });
    expect(await inspectProviderDirectory("material", path.join(installDir, "bound-fixture")))
      .toMatchObject({ version: "1.0.0", healthy: true, bound: true });
    expect(await lifecycleEvents(root)).toEqual([
      expect.objectContaining({ command: "providers install-zip", outcome: "applied" }),
      expect.objectContaining({ command: "providers rollback", outcome: "recovered" }),
    ]);
  });

  it("automatically restores a bound provider when selected-package validation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-bound-zip-restore-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers", "material");
    const initialZip = path.join(root, "initial.zip");
    const updateZip = path.join(root, "update.zip");
    await writeMaterialZip(initialZip, { id: "restore-fixture", version: "1.0.0" });
    await writeMaterialZip(updateZip, { id: "restore-fixture", version: "1.1.0" });
    await installBoundProvider({
      zipPath: initialZip,
      installDir,
      id: "restore-fixture",
      version: "1.0.0",
    });
    const before = await inspectProviderReplacementPrecondition(
      path.join(installDir, "restore-fixture"),
    );
    const plan = await planProviderZipLifecycle(
      await planMaterialProviderZipInstall(updateZip, installDir, { currentVersion: "1.0.0" }),
      { replaceBound: true },
    );

    await expect(
      applyProviderZipLifecyclePlan({
        plan,
        apply: (authorizedPlan, selection) =>
          applyMaterialProviderZipInstallPlan(authorizedPlan, { selection }),
        postInstallValidation: async () => {
          throw new Error("simulated post-install validation failure");
        },
      }),
    ).rejects.toThrow("simulated post-install validation failure");

    const restored = await inspectProviderDirectory("material", path.join(installDir, "restore-fixture"));
    expect(restored).toMatchObject({ version: "1.0.0", healthy: true, bound: true });
    await expect(
      inspectProviderReplacementPrecondition(path.join(installDir, "restore-fixture")),
    ).resolves.toEqual(before);
    await expect(access(plan.ownershipTransition!.rollback.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores exact replacement and rollback authority after final verification faults, then retries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-lifecycle-final-fault-"));
    tempDirs.push(root);
    const providersRoot = path.join(root, "providers");
    const installDir = path.join(providersRoot, "material");
    const initialZip = path.join(root, "initial.zip");
    const updateZip = path.join(root, "update.zip");
    await writeMaterialZip(initialZip, { id: "fault-fixture", version: "1.0.0" });
    await writeMaterialZip(updateZip, { id: "fault-fixture", version: "1.1.0" });
    await installBoundProvider({
      zipPath: initialZip,
      installDir,
      id: "fault-fixture",
      version: "1.0.0",
    });
    const targetPath = path.join(installDir, "fault-fixture");
    const beforeReplacement = await inspectProviderReplacementPrecondition(targetPath);
    const replacementPlan = await planProviderZipLifecycle(
      await planMaterialProviderZipInstall(updateZip, installDir, { currentVersion: "1.0.0" }),
      { replaceBound: true },
    );

    await expect(applyProviderZipLifecyclePlan({
      plan: replacementPlan,
      apply: (authorizedPlan, selection) =>
        applyMaterialProviderZipInstallPlan(authorizedPlan, { selection }),
      postCommitValidation: async () => {
        await writeFile(
          replacementPlan.ownershipTransition!.rollback.recordPath,
          "{corrupt-final-receipt",
          "utf8",
        );
        throw new Error("simulated replacement final assertion failure");
      },
    })).rejects.toThrow("simulated replacement final assertion failure");
    await expect(inspectProviderReplacementPrecondition(targetPath)).resolves.toEqual(beforeReplacement);
    expect(await inspectProviderDirectory("material", targetPath)).toMatchObject({
      version: "1.0.0",
      healthy: true,
      bound: true,
    });
    await expect(access(replacementPlan.ownershipTransition!.rollback.rootPath))
      .rejects.toMatchObject({ code: "ENOENT" });

    const replacement = await applyProviderZipLifecyclePlan({
      plan: replacementPlan,
      apply: (authorizedPlan, selection) =>
        applyMaterialProviderZipInstallPlan(authorizedPlan, { selection }),
    });
    expect(replacement.rollback).toEqual(replacementPlan.ownershipTransition!.rollback);
    await expect(assertProviderRollbackReady(replacement.rollback!)).resolves.toBeUndefined();

    const rollbackPlan = await planProviderRollback({
      providersRoot,
      runtimeKind: "material",
      id: "fault-fixture",
      revision: replacement.rollback!.revision,
    });
    const beforeRollback = await inspectProviderReplacementPrecondition(targetPath);
    await expect(applyProviderRollbackPlan(rollbackPlan, {
      postCommitValidation: async () => {
        throw new Error("simulated rollback final assertion I/O failure");
      },
    })).rejects.toThrow("simulated rollback final assertion I/O failure");
    await expect(inspectProviderReplacementPrecondition(targetPath)).resolves.toEqual(beforeRollback);
    expect(await inspectProviderDirectory("material", targetPath)).toMatchObject({
      version: "1.1.0",
      healthy: true,
      bound: false,
    });
    await expect(assertProviderRollbackReady(rollbackPlan.source)).resolves.toBeUndefined();
    await expect(access(rollbackPlan.displaced!.rootPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(applyProviderRollbackPlan(rollbackPlan)).resolves.toMatchObject({
      restored: true,
      version: "1.0.0",
    });
    expect(await inspectProviderDirectory("material", targetPath)).toMatchObject({
      version: "1.0.0",
      healthy: true,
      bound: true,
    });
  });

  it("rejects a stale uninstall, then removes and rolls back only the selected provider with truthful events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-uninstall-"));
    tempDirs.push(root);
    const providersRoot = path.join(root, "providers");
    const installDir = path.join(providersRoot, "material");
    await writeFile(
      path.join(root, "paper-search.toml"),
      `[providers]\ninstallDir = "${providersRoot.replace(/\\/g, "\\\\")}"\n`,
      "utf8",
    );
    const selectedZip = path.join(root, "selected.zip");
    const neighborZip = path.join(root, "neighbor.zip");
    await writeMaterialZip(selectedZip, { id: "selected-fixture", version: "1.0.0" });
    await writeMaterialZip(neighborZip, { id: "neighbor-fixture", version: "1.0.0" });
    await installBoundProvider({
      zipPath: selectedZip,
      installDir,
      id: "selected-fixture",
      version: "1.0.0",
    });
    await installBoundProvider({
      zipPath: neighborZip,
      installDir,
      id: "neighbor-fixture",
      version: "1.0.0",
    });
    const neighborBefore = await inspectProviderReplacementPrecondition(
      path.join(installDir, "neighbor-fixture"),
    );

    const stalePlan = await planProviderUninstall({
      providersRoot,
      runtimeKind: "material",
      id: "selected-fixture",
    });
    await writeFile(path.join(stalePlan.targetPath, "concurrent.txt"), "changed", "utf8");
    await expect(applyProviderUninstallPlan(stalePlan)).rejects.toThrow(
      "Provider install target changed after planning",
    );
    await rm(path.join(stalePlan.targetPath, "concurrent.txt"));

    const preview = await runCli(root, [
      "providers", "uninstall", "selected-fixture", "--kind", "material", "--json",
    ]);
    expect(preview).toMatchObject({
      ok: true,
      planned: true,
      data: { plan: { rollbackCommand: expect.stringContaining("providers rollback selected-fixture") } },
    });
    expect(await lifecycleEvents(root)).toEqual([]);

    const removed = await runCli(root, [
      "providers", "uninstall", "selected-fixture", "--kind", "material", "--apply", "--json",
    ]);
    expect(removed).toMatchObject({ ok: true, data: { result: { removed: true } } });
    await expect(access(path.join(installDir, "selected-fixture"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      inspectProviderReplacementPrecondition(path.join(installDir, "neighbor-fixture")),
    ).resolves.toEqual(neighborBefore);

    const removalPlan = (removed.data as {
      plan: { rollback: { revision: string } };
    }).plan;
    const rollbackPreview = await runCli(root, [
      "providers", "rollback", "selected-fixture", "--kind", "material",
      "--revision", removalPlan.rollback.revision, "--json",
    ]);
    expect(rollbackPreview).toMatchObject({ ok: true, planned: true });
    const restored = await runCli(root, [
      "providers", "rollback", "selected-fixture", "--kind", "material",
      "--revision", removalPlan.rollback.revision, "--apply", "--json",
    ]);
    expect(restored).toMatchObject({
      ok: true,
      data: { result: { restored: true, version: "1.0.0" } },
    });
    expect(await inspectProviderDirectory("material", path.join(installDir, "selected-fixture")))
      .toMatchObject({ healthy: true, bound: true, version: "1.0.0" });
    await expect(
      inspectProviderReplacementPrecondition(path.join(installDir, "neighbor-fixture")),
    ).resolves.toEqual(neighborBefore);
    expect(await lifecycleEvents(root)).toEqual([
      expect.objectContaining({ command: "providers uninstall", outcome: "applied" }),
      expect.objectContaining({ command: "providers rollback", outcome: "recovered" }),
    ]);
  });
});
