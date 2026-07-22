import { randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { inspectProviderDirectory, type ProviderDirectoryInspection } from "./inventory.js";
import {
  assertProviderReplacementPrecondition,
  inspectProviderReplacementPrecondition,
  readProviderInstallReceipt,
  type ManualZipInstallPlan,
  type ProviderInstallReceipt,
  type ProviderReplacementPrecondition,
  type ProviderRuntimeKind,
} from "./install/manualZip.js";
import {
  replaceInstallPath,
  type InstallPathSelectionOptions,
} from "./install/replace.js";
import {
  assertProviderRollbackReady,
  createProviderRollbackReference,
  loadProviderRollbackReference,
  prepareProviderRollbackRetention,
  removeConsumedProviderRollback,
  retainProviderForUninstall,
  type ProviderRollbackReference,
} from "./rollbackStore.js";
import {
  configuredProviderInstallDir,
  configuredProviderTargetPath,
} from "./paths.js";

export interface BoundProviderZipOwnershipTransition {
  kind: "subscription-bound-to-manual-zip";
  explicit: true;
  from: {
    runtimeKind: ProviderRuntimeKind;
    providerKind: string;
    id: string;
    version: string;
    receipt: ProviderInstallReceipt;
  };
  to: {
    runtimeKind: ProviderRuntimeKind;
    providerKind: string;
    id: string;
    version: string;
    installType: "manual-zip";
    bound: false;
    archiveSha256: string;
  };
  rollback: ProviderRollbackReference;
  rollbackCommand: string;
}

export type ProviderZipLifecyclePlan<TPlan extends ManualZipInstallPlan> = TPlan & {
  ownershipTransition?: BoundProviderZipOwnershipTransition;
};

export interface ProviderUninstallPlan {
  schemaVersion: 1;
  operation: "uninstall";
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  installDir: string;
  targetPath: string;
  targetPrecondition: ProviderReplacementPrecondition;
  receipt: ProviderInstallReceipt;
  rollback: ProviderRollbackReference;
  rollbackCommand: string;
}

export interface ProviderRollbackPlan {
  schemaVersion: 1;
  operation: "rollback";
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  installDir: string;
  targetPath: string;
  targetPrecondition: ProviderReplacementPrecondition;
  source: ProviderRollbackReference;
  displaced?: ProviderRollbackReference;
  redoCommand?: string;
}

export function formatProviderRollbackCommand(reference: ProviderRollbackReference): string {
  return [
    "paper-search providers rollback",
    reference.id,
    `--kind ${reference.runtimeKind}`,
    `--revision ${reference.revision}`,
    "--apply",
  ].join(" ");
}

function assertInspectionIdentity(
  inspection: ProviderDirectoryInspection,
  expected: {
    runtimeKind: ProviderRuntimeKind;
    providerKind: string;
    id: string;
    version: string;
  },
): void {
  if (!inspection.healthy || !inspection.receipt) {
    throw new Error(
      `Provider ${expected.id} is not healthy: ${inspection.issues.join("; ") || "receipt unavailable"}`,
    );
  }
  for (const key of ["runtimeKind", "providerKind", "id", "version"] as const) {
    if (inspection[key] !== expected[key]) {
      throw new Error(`Provider ${expected.id} changed ${key} after planning`);
    }
  }
}

function assertReceiptAuthority(
  actual: ProviderInstallReceipt,
  expected: ProviderInstallReceipt,
  providerId: string,
): void {
  const keys = Object.keys(expected) as Array<keyof ProviderInstallReceipt>;
  if (
    keys.some((key) => actual[key] !== expected[key]) ||
    Object.keys(actual).length !== keys.length
  ) {
    throw new Error(`Provider ${providerId} receipt authority changed after planning`);
  }
}

async function assertSelectedManualZip(
  targetPath: string,
  plan: ManualZipInstallPlan,
): Promise<void> {
  const inspection = await inspectProviderDirectory(plan.runtimeKind, targetPath);
  assertInspectionIdentity(inspection, plan);
  const receipt = inspection.receipt!;
  if (
    receipt.installType !== "manual-zip" ||
    receipt.bound ||
    receipt.archiveSha256 !== plan.archiveSha256 ||
    receipt.manifestSha256 !== plan.manifestSha256 ||
    receipt.entryPath !== plan.entryPath ||
    receipt.entrySha256 !== plan.entrySha256
  ) {
    throw new Error(`Installed provider ${plan.id} does not match the validated ZIP plan`);
  }
}

export async function planProviderZipLifecycle<TPlan extends ManualZipInstallPlan>(
  plan: TPlan,
  options: { replaceBound: boolean },
): Promise<ProviderZipLifecyclePlan<TPlan>> {
  if (plan.replacementPrecondition.state === "absent") {
    if (options.replaceBound) {
      throw new Error(`--replace-bound requires an installed subscription-bound provider: ${plan.id}`);
    }
    return plan;
  }

  const receipt = await readProviderInstallReceipt(plan.targetPath);
  if (!receipt?.bound) {
    if (options.replaceBound) {
      throw new Error(`--replace-bound requires an installed subscription-bound provider: ${plan.id}`);
    }
    return plan;
  }
  if (!options.replaceBound) {
    throw new Error(
      `Provider ${plan.id} is subscription-bound; use providers update or rerun this exact ZIP plan with --replace-bound`,
    );
  }

  const inspection = await inspectProviderDirectory(plan.runtimeKind, plan.targetPath);
  assertInspectionIdentity(inspection, {
    runtimeKind: plan.runtimeKind,
    providerKind: plan.providerKind,
    id: plan.id,
    version: inspection.version,
  });
  assertReceiptAuthority(inspection.receipt!, receipt, plan.id);
  const rollback = createProviderRollbackReference({
    installDir: plan.installDir,
    inspection,
    precondition: plan.replacementPrecondition,
  });
  return {
    ...plan,
    ownershipTransition: {
      kind: "subscription-bound-to-manual-zip",
      explicit: true,
      from: {
        runtimeKind: inspection.runtimeKind,
        providerKind: inspection.providerKind,
        id: inspection.id,
        version: inspection.version,
        receipt,
      },
      to: {
        runtimeKind: plan.runtimeKind,
        providerKind: plan.providerKind,
        id: plan.id,
        version: plan.version,
        installType: "manual-zip",
        bound: false,
        archiveSha256: plan.archiveSha256,
      },
      rollback,
      rollbackCommand: formatProviderRollbackCommand(rollback),
    },
  };
}

export async function assertProviderZipLifecycleAuthority(
  plan: ProviderZipLifecyclePlan<ManualZipInstallPlan>,
): Promise<void> {
  const transition = plan.ownershipTransition;
  if (!transition) return;
  await assertProviderReplacementPrecondition(plan.targetPath, plan.replacementPrecondition);
  const inspection = await inspectProviderDirectory(plan.runtimeKind, plan.targetPath);
  assertInspectionIdentity(inspection, transition.from);
  assertReceiptAuthority(inspection.receipt!, transition.from.receipt, plan.id);
  if (!inspection.receipt!.bound || inspection.receipt!.installType !== "registry") {
    throw new Error(`Provider ${plan.id} is no longer subscription-bound`);
  }
}

export async function applyProviderZipLifecyclePlan<
  TPlan extends ManualZipInstallPlan,
  TResult,
>(options: {
  plan: ProviderZipLifecyclePlan<TPlan>;
  apply: (
    plan: TPlan,
    selection: InstallPathSelectionOptions,
  ) => Promise<TResult>;
  postInstallValidation?: (targetPath: string) => Promise<void>;
  /** Host-only fault/verification seam used before replacement commits. */
  postCommitValidation?: (targetPath: string) => Promise<void>;
}): Promise<TResult & { rollback?: ProviderRollbackReference; rollbackCommand?: string }> {
  await assertProviderZipLifecycleAuthority(options.plan);
  const transition = options.plan.ownershipTransition;
  const prepared = transition
    ? await prepareProviderRollbackRetention({
        reference: transition.rollback,
        reason: "replace-bound-zip",
      })
    : undefined;

  try {
    const result = await options.apply(options.plan, {
      ...(prepared?.retention ? { retention: prepared.retention } : {}),
      validateSelected: async (targetPath) => {
        await assertSelectedManualZip(targetPath, options.plan);
        await options.postInstallValidation?.(targetPath);
      },
      validateCommitted: async (targetPath) => {
        if (transition) await assertProviderRollbackReady(transition.rollback);
        await options.postCommitValidation?.(targetPath);
      },
    });
    return {
      ...result,
      ...(transition
        ? {
            rollback: transition.rollback,
            rollbackCommand: transition.rollbackCommand,
          }
        : {}),
    };
  } catch (error) {
    await prepared?.cleanup();
    throw error;
  }
}

export async function planProviderUninstall(options: {
  providersRoot: string;
  runtimeKind: ProviderRuntimeKind;
  id: string;
}): Promise<ProviderUninstallPlan> {
  const installDir = configuredProviderInstallDir(options.providersRoot, options.runtimeKind);
  const targetPath = configuredProviderTargetPath(
    options.providersRoot,
    options.runtimeKind,
    options.id,
  );
  const targetPrecondition = await inspectProviderReplacementPrecondition(targetPath);
  if (targetPrecondition.state !== "present") {
    throw new Error(`Provider ${options.id} is not installed as ${options.runtimeKind}`);
  }
  const inspection = await inspectProviderDirectory(options.runtimeKind, targetPath);
  assertInspectionIdentity(inspection, {
    runtimeKind: options.runtimeKind,
    providerKind: inspection.providerKind,
    id: options.id,
    version: inspection.version,
  });
  const rollback = createProviderRollbackReference({
    installDir,
    inspection,
    precondition: targetPrecondition,
  });
  return {
    schemaVersion: 1,
    operation: "uninstall",
    runtimeKind: options.runtimeKind,
    providerKind: inspection.providerKind,
    id: inspection.id,
    version: inspection.version,
    installDir,
    targetPath,
    targetPrecondition,
    receipt: inspection.receipt!,
    rollback,
    rollbackCommand: formatProviderRollbackCommand(rollback),
  };
}

export async function applyProviderUninstallPlan(
  plan: ProviderUninstallPlan,
): Promise<{
  removed: true;
  rollback: ProviderRollbackReference;
  rollbackCommand: string;
}> {
  await assertProviderReplacementPrecondition(plan.targetPath, plan.targetPrecondition);
  const inspection = await inspectProviderDirectory(plan.runtimeKind, plan.targetPath);
  assertInspectionIdentity(inspection, plan);
  assertReceiptAuthority(inspection.receipt!, plan.receipt, plan.id);
  const prepared = await prepareProviderRollbackRetention({
    reference: plan.rollback,
    reason: "uninstall",
  });
  try {
    await retainProviderForUninstall({ targetPath: plan.targetPath, prepared });
    return {
      removed: true,
      rollback: plan.rollback,
      rollbackCommand: plan.rollbackCommand,
    };
  } catch (error) {
    await prepared.cleanup();
    throw error;
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function planProviderRollback(options: {
  providersRoot: string;
  runtimeKind: ProviderRuntimeKind;
  id: string;
  revision: string;
}): Promise<ProviderRollbackPlan> {
  const installDir = configuredProviderInstallDir(options.providersRoot, options.runtimeKind);
  const source = await loadProviderRollbackReference({
    installDir,
    id: options.id,
    revision: options.revision,
  });
  if (source.runtimeKind !== options.runtimeKind) {
    throw new Error(`Provider rollback revision belongs to ${source.runtimeKind}/${source.id}`);
  }
  const sourceInspection = await inspectProviderDirectory(source.runtimeKind, source.providerPath);
  assertInspectionIdentity(sourceInspection, source);

  const targetPath = configuredProviderTargetPath(
    options.providersRoot,
    options.runtimeKind,
    options.id,
  );
  const targetPrecondition = await inspectProviderReplacementPrecondition(targetPath);
  let displaced: ProviderRollbackReference | undefined;
  if (targetPrecondition.state === "present") {
    const current = await inspectProviderDirectory(options.runtimeKind, targetPath);
    assertInspectionIdentity(current, {
      runtimeKind: options.runtimeKind,
      providerKind: current.providerKind,
      id: options.id,
      version: current.version,
    });
    displaced = createProviderRollbackReference({
      installDir,
      inspection: current,
      precondition: targetPrecondition,
    });
    if (displaced.revision === source.revision) {
      throw new Error(`Provider ${options.id} is already at rollback revision ${source.revision}`);
    }
  }
  return {
    schemaVersion: 1,
    operation: "rollback",
    runtimeKind: source.runtimeKind,
    providerKind: source.providerKind,
    id: source.id,
    version: source.version,
    installDir,
    targetPath,
    targetPrecondition,
    source,
    ...(displaced
      ? {
          displaced,
          redoCommand: formatProviderRollbackCommand(displaced),
        }
      : {}),
  };
}

export async function applyProviderRollbackPlan(
  plan: ProviderRollbackPlan,
  hooks: { postCommitValidation?: (targetPath: string) => Promise<void> } = {},
): Promise<{
  restored: true;
  version: string;
  retainedDisplaced?: ProviderRollbackReference;
  redoCommand?: string;
  warnings: string[];
}> {
  await assertProviderReplacementPrecondition(plan.targetPath, plan.targetPrecondition);
  const source = await loadProviderRollbackReference({
    installDir: plan.installDir,
    id: plan.id,
    revision: plan.source.revision,
  });
  if (source.recordPath !== plan.source.recordPath) {
    throw new Error(`Provider rollback source changed after planning: ${plan.id}`);
  }

  const displacedPrepared = plan.displaced
    ? await prepareProviderRollbackRetention({
        reference: plan.displaced,
        reason: "rollback-displaced",
      })
    : undefined;
  const stagingPath = path.join(
    plan.installDir,
    `._${plan.id}_rollback_${randomUUID()}`,
  );
  await rename(source.providerPath, stagingPath);
  try {
    await replaceInstallPath({
      stagingPath,
      targetPath: plan.targetPath,
      providerId: plan.id,
      restoreStagingOnFailure: true,
      ...(displacedPrepared?.retention
        ? { retention: displacedPrepared.retention }
        : {}),
      validateSelected: async (targetPath) => {
        const state = await inspectProviderReplacementPrecondition(targetPath);
        if (state.state !== "present" || state.digest !== source.revision) {
          throw new Error(`Restored provider revision does not match ${source.revision}`);
        }
        const inspection = await inspectProviderDirectory(plan.runtimeKind, targetPath);
        assertInspectionIdentity(inspection, source);
      },
      validateCommitted: async (targetPath) => {
        await assertProviderReplacementPrecondition(targetPath, {
          state: "present",
          digest: source.revision,
        });
        if (plan.displaced) await assertProviderRollbackReady(plan.displaced);
        await hooks.postCommitValidation?.(targetPath);
      },
    });
  } catch (error) {
    if (await exists(stagingPath)) {
      await rename(stagingPath, source.providerPath).catch(() => undefined);
    }
    await displacedPrepared?.cleanup();
    throw error;
  }

  const warnings: string[] = [];
  const cleanupWarning = await removeConsumedProviderRollback(source);
  if (cleanupWarning) warnings.push(cleanupWarning);
  return {
    restored: true,
    version: plan.version,
    ...(plan.displaced
      ? {
          retainedDisplaced: plan.displaced,
          redoCommand: plan.redoCommand,
        }
      : {}),
    warnings,
  };
}
