import { createHash } from "node:crypto";
import path from "node:path";
import {
  applyMaterialProviderZipInstallWithReceipt,
  inspectMaterialProviderZipFile,
} from "../material/install/package.js";
import { tryAppendLifecycleEvent } from "../runtime/eventLedger.js";
import { getSystemVersion, semverCompare, semverGte } from "../runtime/version.js";
import { withLocks } from "../subscriptions/locks.js";
import { readCurrentRegistrySnapshot } from "../subscriptions/registry.js";
import { showSubscription } from "../subscriptions/service.js";
import type {
  RegistryCandidateSummary,
  RegistrySnapshotSummary,
  SubscriptionIdentity,
} from "../subscriptions/types.js";
import {
  assertCachedProviderArchive,
  ensureProviderArchiveCached,
  resolveProviderArchiveRef,
  type ResolvedProviderArchive,
} from "./archiveCache.js";
import { selectAvailableProvider } from "./catalog.js";
import {
  applyProviderZipInstallWithReceipt,
  inspectProviderZipFile,
} from "./install/zip.js";
import {
  PROVIDER_RECEIPT_FILENAME,
  type ProviderInstallReceipt,
  type ProviderRuntimeKind,
} from "./install/manualZip.js";
import {
  assertProviderNamespacePrecondition,
  captureProviderNamespacePrecondition,
  inspectProviderDirectory,
  listProviderInstallations,
  namespacePresentKinds,
  type ProviderDirectoryInspection,
  type ProviderNamespacePrecondition,
} from "./inventory.js";
import { providerInstallDir, providerTargetPath } from "./paths.js";

export type ProviderLifecycleAction = "install" | "update" | "skip" | "blocked";

export interface ProviderBindingPin {
  subscriptionId: string;
  sourceFingerprint: string;
  canonicalSource: string;
  registryDigest: string;
}

export interface ProviderArchivePin {
  sourceType: "https" | "local";
  sourceRef: string;
  displayRef: string;
  archiveSha256: string;
  cachePath: string;
}

export interface ProviderPackagePin {
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
}

export interface ProviderLifecyclePlan {
  schemaVersion: 1;
  operation: "install" | "update";
  action: ProviderLifecycleAction;
  reason: string;
  id: string;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string | null;
  version: string;
  installedVersion: string | null;
  currentCliVersion: string;
  binding: ProviderBindingPin | null;
  archive: ProviderArchivePin | null;
  package: ProviderPackagePin | null;
  targetPath: string;
  filesystemOperations: string[];
  installedStatePrecondition: ProviderNamespacePrecondition;
  planDigest: string;
}

export interface ProviderUpdatePlanSet {
  schemaVersion: 1;
  plans: ProviderLifecyclePlan[];
  planDigest: string;
}

export interface AppliedProviderLifecyclePlan {
  plan: ProviderLifecyclePlan;
  applied: boolean;
  result?: {
    id: string;
    version: string;
    installPath: string;
    replacedExisting: boolean;
  };
  receipt?: ProviderInstallReceipt;
  auditWarnings?: string[];
}

interface CandidateContext {
  identity: SubscriptionIdentity;
  snapshot: RegistrySnapshotSummary;
  candidate: RegistryCandidateSummary;
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function finalizePlan(
  value: Omit<ProviderLifecyclePlan, "planDigest">,
): ProviderLifecyclePlan {
  return { ...value, planDigest: hashPlan(value) };
}

function assertProviderLifecyclePlanIntegrity(
  plan: ProviderLifecyclePlan,
  env: NodeJS.ProcessEnv,
): void {
  if (
    plan.schemaVersion !== 1 ||
    (plan.runtimeKind !== "search" && plan.runtimeKind !== "material") ||
    !/^[a-z][a-z0-9_-]{1,63}$/.test(plan.id)
  ) {
    throw new Error("Provider lifecycle plan shape is invalid");
  }
  const { planDigest, ...unsignedPlan } = plan;
  if (hashPlan(unsignedPlan) !== planDigest) {
    throw new Error(`Provider lifecycle plan digest mismatch: ${plan.id}`);
  }
  const expectedTarget = path.resolve(providerTargetPath(plan.runtimeKind, plan.id, env));
  const actualTarget = path.resolve(plan.targetPath);
  const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(actualTarget) !== comparable(expectedTarget)) {
    throw new Error(`Provider lifecycle plan target is invalid: ${plan.id}`);
  }
}

function blockedPlan(options: {
  operation: ProviderLifecyclePlan["operation"];
  reason: string;
  id: string;
  runtimeKind: ProviderRuntimeKind;
  providerKind?: string | null;
  version: string;
  installedVersion?: string | null;
  currentCliVersion: string;
  binding?: ProviderBindingPin | null;
  targetPath: string;
  precondition: ProviderNamespacePrecondition;
}): ProviderLifecyclePlan {
  return finalizePlan({
    schemaVersion: 1,
    operation: options.operation,
    action: "blocked",
    reason: options.reason,
    id: options.id,
    runtimeKind: options.runtimeKind,
    providerKind: options.providerKind ?? null,
    version: options.version,
    installedVersion: options.installedVersion ?? null,
    currentCliVersion: options.currentCliVersion,
    binding: options.binding ?? null,
    archive: null,
    package: null,
    targetPath: options.targetPath,
    filesystemOperations: [],
    installedStatePrecondition: options.precondition,
  });
}

async function loadCandidateContext(
  subscriptionId: string,
  providerId: string,
  env: NodeJS.ProcessEnv,
): Promise<CandidateContext> {
  const subscription = await showSubscription(subscriptionId, env);
  if (subscription.status !== "active" || !subscription.identity) {
    throw new Error(`Provider source subscription is not active: ${subscriptionId} (${subscription.status})`);
  }
  const loaded = await readCurrentRegistrySnapshot(subscriptionId, subscription.identity, env);
  if (!loaded) throw new Error(`Provider source has no validated snapshot: ${subscriptionId}`);
  const candidates = loaded.candidates.filter((candidate) => candidate.id === providerId);
  if (candidates.length !== 1) {
    throw new Error(`Provider ${providerId} is not uniquely present in subscription ${subscriptionId}`);
  }
  return { identity: subscription.identity, snapshot: loaded.summary, candidate: candidates[0]! };
}

function bindingPin(context: CandidateContext): ProviderBindingPin {
  return {
    subscriptionId: context.snapshot.subscriptionId,
    sourceFingerprint: context.identity.sourceFingerprint,
    canonicalSource: context.identity.canonicalSource,
    registryDigest: context.snapshot.registryDigest,
  };
}

async function inspectCachedPackage(options: {
  runtimeKind: ProviderRuntimeKind;
  cachePath: string;
  id: string;
  version: string;
  archiveSha256: string;
  providerKind?: string;
  currentCliVersion: string;
}): Promise<{ providerKind: string; package: ProviderPackagePin }> {
  if (options.runtimeKind === "search") {
    const inspected = await inspectProviderZipFile(options.cachePath, {
      id: options.id,
      version: options.version,
      sha256: options.archiveSha256,
      currentVersion: options.currentCliVersion,
    });
    return {
      providerKind: inspected.providerKind,
      package: {
        manifestSha256: inspected.manifestSha256,
        entryPath: inspected.entryPath,
        entrySha256: inspected.entrySha256,
      },
    };
  }
  const inspected = await inspectMaterialProviderZipFile(options.cachePath, {
    id: options.id,
    version: options.version,
    ...(options.providerKind ? { kind: options.providerKind as never } : {}),
    currentVersion: options.currentCliVersion,
    registryChecksum: { sha256: options.archiveSha256, target: "archive" },
  });
  return {
    providerKind: inspected.providerKind,
    package: {
      manifestSha256: inspected.manifestSha256,
      entryPath: inspected.entryPath,
      entrySha256: inspected.entrySha256,
    },
  };
}

async function buildActionablePlan(options: {
  operation: "install" | "update";
  context: CandidateContext;
  installedVersion: string | null;
  precondition: ProviderNamespacePrecondition;
  currentCliVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<ProviderLifecyclePlan> {
  const { context } = options;
  const targetPath = providerTargetPath(context.identity.runtimeKind, context.candidate.id, options.env);
  const binding = bindingPin(context);
  if (context.candidate.status === "blocked" || !context.candidate.archiveSha256) {
    return blockedPlan({
      operation: options.operation,
      reason: context.candidate.blockedReason ?? "candidate is blocked",
      id: context.candidate.id,
      runtimeKind: context.identity.runtimeKind,
      providerKind: context.candidate.providerKind,
      version: context.candidate.version,
      installedVersion: options.installedVersion,
      currentCliVersion: options.currentCliVersion,
      binding,
      targetPath,
      precondition: options.precondition,
    });
  }
  if (
    context.candidate.minRequiredVersion &&
    !semverGte(options.currentCliVersion, context.candidate.minRequiredVersion)
  ) {
    return blockedPlan({
      operation: options.operation,
      reason: `requires paper-search-cli >= ${context.candidate.minRequiredVersion}`,
      id: context.candidate.id,
      runtimeKind: context.identity.runtimeKind,
      providerKind: context.candidate.providerKind,
      version: context.candidate.version,
      installedVersion: options.installedVersion,
      currentCliVersion: options.currentCliVersion,
      binding,
      targetPath,
      precondition: options.precondition,
    });
  }
  const resolvedArchive = resolveProviderArchiveRef({
    identity: context.identity,
    snapshot: context.snapshot,
    candidate: context.candidate,
  });
  const cached = await ensureProviderArchiveCached({
    source: resolvedArchive,
    archiveSha256: context.candidate.archiveSha256,
    env: options.env,
  });
  const inspected = await inspectCachedPackage({
    runtimeKind: context.identity.runtimeKind,
    cachePath: cached.cachePath,
    id: context.candidate.id,
    version: context.candidate.version,
    archiveSha256: context.candidate.archiveSha256,
    providerKind: context.candidate.providerKind,
    currentCliVersion: options.currentCliVersion,
  });
  return finalizePlan({
    schemaVersion: 1,
    operation: options.operation,
    action: options.operation,
    reason: options.operation === "install" ? "not installed" : "registry version is newer",
    id: context.candidate.id,
    runtimeKind: context.identity.runtimeKind,
    providerKind: inspected.providerKind,
    version: context.candidate.version,
    installedVersion: options.installedVersion,
    currentCliVersion: options.currentCliVersion,
    binding,
    archive: {
      sourceType: cached.sourceType,
      sourceRef: cached.ref,
      displayRef: cached.displayRef,
      archiveSha256: cached.archiveSha256,
      cachePath: cached.cachePath,
    },
    package: inspected.package,
    targetPath,
    filesystemOperations: [
      `verify cache/${cached.archiveSha256}.zip`,
      `${options.operation} ${context.identity.runtimeKind}/${context.candidate.id}`,
      `write ${path.join(targetPath, PROVIDER_RECEIPT_FILENAME)}`,
    ],
    installedStatePrecondition: options.precondition,
  });
}

export async function planProviderInstall(
  id: string,
  options: { from?: string; env?: NodeJS.ProcessEnv; currentCliVersion?: string } = {},
): Promise<ProviderLifecyclePlan> {
  const env = options.env ?? process.env;
  const currentCliVersion = options.currentCliVersion ?? getSystemVersion();
  const selected = await selectAvailableProvider({ id, from: options.from, env });
  const context = await loadCandidateContext(selected.subscriptionId, id, env);
  if (
    context.identity.sourceFingerprint !== selected.sourceFingerprint ||
    context.snapshot.registryDigest !== selected.registryDigest
  ) {
    throw new Error(`Provider catalog changed while planning install: ${id}`);
  }
  const precondition = await captureProviderNamespacePrecondition(id, env);
  const identityOwners = (await listProviderInstallations(env)).filter((entry) => entry.id === id);
  if (identityOwners.length > 0) {
    return blockedPlan({
      operation: "install",
      reason: `provider id is already installed in the global namespace (${identityOwners
        .map((entry) => `${entry.runtimeKind}:${entry.path}`)
        .join(", ")})`,
      id,
      runtimeKind: context.identity.runtimeKind,
      providerKind: context.candidate.providerKind,
      version: context.candidate.version,
      currentCliVersion,
      binding: bindingPin(context),
      targetPath: providerTargetPath(context.identity.runtimeKind, id, env),
      precondition,
    });
  }
  const present = namespacePresentKinds(precondition);
  if (present.length > 0) {
    return blockedPlan({
      operation: "install",
      reason: `provider id is already installed in the global namespace (${present.join(", ")})`,
      id,
      runtimeKind: context.identity.runtimeKind,
      providerKind: context.candidate.providerKind,
      version: context.candidate.version,
      currentCliVersion,
      binding: bindingPin(context),
      targetPath: providerTargetPath(context.identity.runtimeKind, id, env),
      precondition,
    });
  }
  return buildActionablePlan({
    operation: "install",
    context,
    installedVersion: null,
    precondition,
    currentCliVersion,
    env,
  });
}

async function planInstalledProviderUpdate(
  installed: ProviderDirectoryInspection,
  currentCliVersion: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderLifecyclePlan> {
  const precondition = await captureProviderNamespacePrecondition(installed.id, env);
  const targetPath = providerTargetPath(installed.runtimeKind, installed.id, env);
  if (!installed.healthy || !installed.receipt) {
    return blockedPlan({
      operation: "update",
      reason: installed.issues.join("; ") || "installed provider is unhealthy",
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: installed.version,
      installedVersion: installed.version,
      currentCliVersion,
      targetPath,
      precondition,
    });
  }
  const receipt = installed.receipt;
  if (
    !receipt.bound ||
    receipt.installType !== "registry" ||
    !receipt.subscriptionId ||
    !receipt.sourceFingerprint ||
    !receipt.canonicalSource
  ) {
    return blockedPlan({
      operation: "update",
      reason: "installed provider is unbound and has no authorized update source",
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: installed.version,
      installedVersion: installed.version,
      currentCliVersion,
      targetPath,
      precondition,
    });
  }

  let context: CandidateContext;
  try {
    context = await loadCandidateContext(receipt.subscriptionId, installed.id, env);
  } catch (error) {
    return blockedPlan({
      operation: "update",
      reason: error instanceof Error ? error.message : String(error),
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: installed.version,
      installedVersion: installed.version,
      currentCliVersion,
      binding: {
        subscriptionId: receipt.subscriptionId,
        sourceFingerprint: receipt.sourceFingerprint,
        canonicalSource: receipt.canonicalSource,
        registryDigest: receipt.registryDigest ?? "0".repeat(64),
      },
      targetPath,
      precondition,
    });
  }
  if (
    context.identity.runtimeKind !== installed.runtimeKind ||
    context.identity.sourceFingerprint !== receipt.sourceFingerprint ||
    context.identity.canonicalSource !== receipt.canonicalSource
  ) {
    return blockedPlan({
      operation: "update",
      reason: "installed receipt origin no longer matches the active subscription identity",
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: context.candidate.version,
      installedVersion: installed.version,
      currentCliVersion,
      binding: bindingPin(context),
      targetPath,
      precondition,
    });
  }
  const present = namespacePresentKinds(precondition);
  if (present.length !== 1 || present[0] !== installed.runtimeKind) {
    return blockedPlan({
      operation: "update",
      reason: `provider id has conflicting global namespace owners (${present.join(", ") || "none"})`,
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: context.candidate.version,
      installedVersion: installed.version,
      currentCliVersion,
      binding: bindingPin(context),
      targetPath,
      precondition,
    });
  }
  if (semverCompare(installed.version, context.candidate.version) >= 0) {
    return finalizePlan({
      schemaVersion: 1,
      operation: "update",
      action: "skip",
      reason: installed.version === context.candidate.version
        ? "already up to date"
        : "installed version is newer than registry",
      id: installed.id,
      runtimeKind: installed.runtimeKind,
      providerKind: installed.providerKind,
      version: context.candidate.version,
      installedVersion: installed.version,
      currentCliVersion,
      binding: bindingPin(context),
      archive: null,
      package: null,
      targetPath,
      filesystemOperations: [],
      installedStatePrecondition: precondition,
    });
  }
  return buildActionablePlan({
    operation: "update",
    context,
    installedVersion: installed.version,
    precondition,
    currentCliVersion,
    env,
  });
}

export async function planProviderUpdates(
  ids: readonly string[] = [],
  options: { env?: NodeJS.ProcessEnv; currentCliVersion?: string } = {},
): Promise<ProviderUpdatePlanSet> {
  const env = options.env ?? process.env;
  const currentCliVersion = options.currentCliVersion ?? getSystemVersion();
  const installed = await listProviderInstallations(env);
  const selectedIds = [...new Set(ids)];
  if (selectedIds.length > 0) {
    const missing = selectedIds.filter((id) => !installed.some((entry) => entry.id === id));
    if (missing.length > 0) throw new Error(`Installed provider(s) not found: ${missing.join(", ")}`);
  }
  const selected = installed.filter((entry) => selectedIds.length === 0 || selectedIds.includes(entry.id));
  const plans: ProviderLifecyclePlan[] = [];
  for (const entry of selected.sort((left, right) => left.id.localeCompare(right.id))) {
    plans.push(await planInstalledProviderUpdate(entry, currentCliVersion, env));
  }
  const base = { schemaVersion: 1 as const, plans };
  return { ...base, planDigest: hashPlan(base) };
}

function assertPlanPackage(
  plan: ProviderLifecyclePlan,
  inspected: { providerKind: string; package: ProviderPackagePin },
): void {
  if (!plan.package || plan.providerKind !== inspected.providerKind) {
    throw new Error(`Provider package changed after planning: ${plan.id}`);
  }
  for (const key of ["manifestSha256", "entryPath", "entrySha256"] as const) {
    if (plan.package[key] !== inspected.package[key]) {
      throw new Error(`Provider package changed after planning: ${key}`);
    }
  }
}

function receiptForPlan(
  plan: ProviderLifecyclePlan,
  installedAt: string,
): ProviderInstallReceipt {
  if (!plan.binding || !plan.archive || !plan.package || !plan.providerKind) {
    throw new Error(`Provider plan is missing bound receipt fields: ${plan.id}`);
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runtimeKind: plan.runtimeKind,
    providerKind: plan.providerKind,
    id: plan.id,
    version: plan.version,
    installType: "registry",
    bound: true,
    subscriptionId: plan.binding.subscriptionId,
    sourceFingerprint: plan.binding.sourceFingerprint,
    canonicalSource: plan.binding.canonicalSource,
    registryDigest: plan.binding.registryDigest,
    archiveSha256: plan.archive.archiveSha256,
    manifestSha256: plan.package.manifestSha256,
    entryPath: plan.package.entryPath,
    entrySha256: plan.package.entrySha256,
    installedAt,
    updatedAt: now,
  };
}

async function assertCurrentPlanBinding(
  plan: ProviderLifecyclePlan,
  env: NodeJS.ProcessEnv,
): Promise<CandidateContext> {
  if (!plan.binding || !plan.archive) throw new Error(`Provider plan is not source-bound: ${plan.id}`);
  const context = await loadCandidateContext(plan.binding.subscriptionId, plan.id, env);
  if (
    context.identity.sourceFingerprint !== plan.binding.sourceFingerprint ||
    context.identity.canonicalSource !== plan.binding.canonicalSource ||
    context.snapshot.registryDigest !== plan.binding.registryDigest ||
    context.candidate.version !== plan.version ||
    context.candidate.archiveSha256 !== plan.archive.archiveSha256
  ) {
    throw new Error(`Provider source or registry snapshot changed after planning: ${plan.id}`);
  }
  const resolved = resolveProviderArchiveRef({
    identity: context.identity,
    snapshot: context.snapshot,
    candidate: context.candidate,
  });
  if (
    resolved.sourceType !== plan.archive.sourceType ||
    resolved.ref !== plan.archive.sourceRef
  ) {
    throw new Error(`Provider archive reference changed after planning: ${plan.id}`);
  }
  return context;
}

export async function applyProviderLifecyclePlan(
  plan: ProviderLifecyclePlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppliedProviderLifecyclePlan> {
  assertProviderLifecyclePlanIntegrity(plan, env);
  if (plan.action !== "install" && plan.action !== "update") {
    return { plan, applied: false };
  }
  if (!plan.binding || !plan.archive || !plan.package || !plan.providerKind) {
    throw new Error(`Provider plan is incomplete: ${plan.id}`);
  }
  const source: ResolvedProviderArchive = {
    sourceType: plan.archive.sourceType,
    ref: plan.archive.sourceRef,
    displayRef: plan.archive.displayRef,
  };
  const cached = await ensureProviderArchiveCached({
    source,
    archiveSha256: plan.archive.archiveSha256,
    env,
  });
  if (cached.cachePath !== plan.archive.cachePath) {
    throw new Error(`Provider archive cache location changed after planning: ${plan.id}`);
  }
  await assertCachedProviderArchive(plan.archive.cachePath, plan.archive.archiveSha256);

  const mutation = await withLocks(
    [`subscription/${plan.binding.subscriptionId}`, `provider/${plan.id}`],
    async () => {
      await assertCurrentPlanBinding(plan, env);
      await assertProviderNamespacePrecondition(plan.id, plan.installedStatePrecondition, env);
      const target = path.resolve(plan.targetPath);
      const comparable = (value: string) => process.platform === "win32"
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
      const unexpectedOwners = (await listProviderInstallations(env)).filter((entry) =>
        entry.id === plan.id && comparable(entry.path) !== comparable(target));
      if (unexpectedOwners.length > 0) {
        throw new Error(
          `Provider id has another installed filesystem owner: ${plan.id} (${unexpectedOwners
            .map((entry) => entry.path)
            .join(", ")})`,
        );
      }
      const inspected = await inspectCachedPackage({
        runtimeKind: plan.runtimeKind,
        cachePath: plan.archive!.cachePath,
        id: plan.id,
        version: plan.version,
        archiveSha256: plan.archive!.archiveSha256,
        providerKind: plan.providerKind ?? undefined,
        currentCliVersion: plan.currentCliVersion,
      });
      assertPlanPackage(plan, inspected);
      let installedAt = new Date().toISOString();
      if (plan.action === "update") {
        const current = await inspectProviderDirectory(plan.runtimeKind, plan.targetPath);
        if (
          !current.receipt?.bound ||
          current.receipt.sourceFingerprint !== plan.binding!.sourceFingerprint ||
          current.receipt.subscriptionId !== plan.binding!.subscriptionId
        ) {
          throw new Error(`Installed provider ownership changed after planning: ${plan.id}`);
        }
        installedAt = current.receipt.installedAt;
      }
      const receipt = receiptForPlan(plan, installedAt);
      const installDir = providerInstallDir(plan.runtimeKind, env);
      const result = plan.runtimeKind === "search"
        ? await applyProviderZipInstallWithReceipt({
            zipPath: plan.archive!.cachePath,
            installDir,
            expectation: {
              id: plan.id,
              version: plan.version,
              sha256: plan.archive!.archiveSha256,
              currentVersion: plan.currentCliVersion,
            },
            receipt,
            replacementPrecondition: plan.installedStatePrecondition.search,
          })
        : await applyMaterialProviderZipInstallWithReceipt({
            zipPath: plan.archive!.cachePath,
            installDir,
            expectation: {
              id: plan.id,
              version: plan.version,
              kind: plan.providerKind as never,
              currentVersion: plan.currentCliVersion,
              registryChecksum: { sha256: plan.archive!.archiveSha256, target: "archive" },
            },
            receipt,
            replacementPrecondition: plan.installedStatePrecondition.material,
          });
      return { result, receipt };
    },
    { env, command: `providers ${plan.operation}` },
  );

  const audit = await tryAppendLifecycleEvent({
    command: `providers ${plan.operation}`,
    planDigest: plan.planDigest,
    affectedIds: [plan.id],
    sourceFingerprint: plan.binding.sourceFingerprint,
    registryDigest: plan.binding.registryDigest,
    archiveSha256: plan.archive.archiveSha256,
    outcome: "applied",
  }, env);
  return {
    plan,
    applied: true,
    result: {
      id: mutation.result.id,
      version: mutation.result.manifest.version,
      installPath: mutation.result.installPath,
      replacedExisting: mutation.result.replacedExisting,
    },
    receipt: mutation.receipt,
    ...(audit.warning ? { auditWarnings: [audit.warning] } : {}),
  };
}

export async function executeProviderInstall(
  id: string,
  options: { from?: string; apply?: boolean; env?: NodeJS.ProcessEnv; currentCliVersion?: string } = {},
): Promise<AppliedProviderLifecyclePlan> {
  const env = options.env ?? process.env;
  const plan = await planProviderInstall(id, {
    from: options.from,
    env,
    currentCliVersion: options.currentCliVersion,
  });
  return options.apply ? applyProviderLifecyclePlan(plan, env) : { plan, applied: false };
}

export async function executeProviderUpdates(
  ids: readonly string[] = [],
  options: { apply?: boolean; env?: NodeJS.ProcessEnv; currentCliVersion?: string } = {},
): Promise<{
  plan: ProviderUpdatePlanSet;
  results: AppliedProviderLifecyclePlan[];
  auditWarnings?: string[];
}> {
  const env = options.env ?? process.env;
  const plan = await planProviderUpdates(ids, { env, currentCliVersion: options.currentCliVersion });
  if (!options.apply) return { plan, results: [] };
  const results: AppliedProviderLifecyclePlan[] = [];
  for (const item of plan.plans) {
    results.push(await applyProviderLifecyclePlan(item, env));
  }
  const auditWarnings = results.flatMap((result) => result.auditWarnings ?? []);
  return { plan, results, ...(auditWarnings.length > 0 ? { auditWarnings } : {}) };
}
