import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteConfigFile } from "../config/userConfig.js";
import { parseMaterialProviderManifest } from "../material/manifest.js";
import { tryAppendLifecycleEvent } from "../runtime/eventLedger.js";
import { withLocks } from "../subscriptions/locks.js";
import {
  assertProviderReplacementPrecondition,
  inspectProviderPreconditionWithoutReceipt,
  inspectProviderReplacementPrecondition,
  sha256Bytes,
  stageProviderReceipt,
  readProviderInstallReceipt,
  type ProviderInstallReceipt,
  type ProviderReplacementPrecondition,
  type ProviderRuntimeKind,
} from "./install/manualZip.js";
import { replaceInstallPath } from "./install/replace.js";
import { parseProviderManifest } from "./manifest/validate.js";
import {
  assertProviderNamespacePrecondition,
  captureProviderNamespacePrecondition,
  inspectProviderDirectory,
  namespacePresentKinds,
  type ProviderNamespacePrecondition,
} from "./inventory.js";
import { providerInstallDir, providerTargetPath, resolveProviderLifecyclePaths } from "./paths.js";

export interface ProviderDirectoryMigrationEntry {
  id: string;
  runtimeKind: ProviderRuntimeKind | null;
  providerKind: string | null;
  version: string | null;
  sourcePath: string;
  targetPath: string | null;
  action: "migrate" | "blocked";
  reason: string;
  strategy: "rename" | "copy" | null;
  manifestSha256: string | null;
  entryPath: string | null;
  entrySha256: string | null;
  sourcePrecondition: ProviderReplacementPrecondition;
  targetPrecondition: ProviderReplacementPrecondition | null;
  preserveReceipt: boolean;
  namespacePrecondition: ProviderNamespacePrecondition | null;
}

export interface ProviderDirectoryMigrationPlan {
  schemaVersion: 1;
  sourceRoot: string;
  targetRoot: string;
  entries: ProviderDirectoryMigrationEntry[];
  planDigest: string;
}

interface ProviderMigrationJournal {
  schemaVersion: 1;
  operationId: string;
  providerId: string;
  runtimeKind: ProviderRuntimeKind;
  planDigest: string;
  sourceRoot: string;
  sourcePath: string;
  targetPath: string;
  stagingPath: string;
  strategy: "rename" | "copy";
  sourceDigest: string;
  sourceHadReceipt: boolean;
  status: "pending" | "selected" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface AppliedProviderDirectoryMigration {
  plan: ProviderDirectoryMigrationPlan;
  migrated: string[];
  blocked: ProviderDirectoryMigrationEntry[];
  recovered: string[];
  auditWarnings?: string[];
}

export interface RecoveredProviderDirectoryMigrations {
  recovered: string[];
  auditWarnings?: string[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function nearestExistingDevice(targetPath: string): Promise<number> {
  let candidate = path.resolve(targetPath);
  for (;;) {
    try {
      return (await stat(candidate)).dev;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function sameVolume(left: string, right: string): Promise<boolean> {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (process.platform === "win32") {
    return normalize(path.parse(path.resolve(left)).root) === normalize(path.parse(path.resolve(right)).root);
  }
  const [leftDevice, rightDevice] = await Promise.all([
    nearestExistingDevice(left),
    nearestExistingDevice(path.dirname(right)),
  ]);
  return leftDevice === rightDevice;
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

async function classifyLegacyProvider(providerPath: string): Promise<{
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
  preserveReceipt: boolean;
}> {
  const manifestText = await readFile(path.join(providerPath, "manifest.json"), "utf8");
  const matches: Array<{
    runtimeKind: ProviderRuntimeKind;
    providerKind: string;
    id: string;
    version: string;
    entryPath: string;
  }> = [];
  try {
    const manifest = parseProviderManifest(manifestText);
    matches.push({
      runtimeKind: "search",
      providerKind: manifest.sourceType,
      id: manifest.id,
      version: manifest.version,
      entryPath: "provider.js",
    });
  } catch {
    // Try the independent material manifest contract below.
  }
  try {
    const manifest = parseMaterialProviderManifest(manifestText);
    matches.push({
      runtimeKind: "material",
      providerKind: manifest.kind,
      id: manifest.id,
      version: manifest.version,
      entryPath: manifest.entry.replace(/\\/g, "/"),
    });
  } catch {
    // Report one deterministic invalid/ambiguous classification below.
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "manifest does not match a search or material provider contract"
      : "manifest matches both search and material provider contracts");
  }
  const match = matches[0]!;
  const entryBytes = new Uint8Array(await readFile(path.join(providerPath, ...match.entryPath.split("/"))));
  const manifestSha256 = sha256Bytes(manifestText);
  const entrySha256 = sha256Bytes(entryBytes);
  const receipt = await readProviderInstallReceipt(providerPath);
  if (receipt && (
    receipt.runtimeKind !== match.runtimeKind ||
    receipt.providerKind !== match.providerKind ||
    receipt.id !== match.id ||
    receipt.version !== match.version ||
    receipt.manifestSha256 !== manifestSha256 ||
    receipt.entryPath !== match.entryPath ||
    receipt.entrySha256 !== entrySha256
  )) {
    throw new Error("existing provider receipt does not match the legacy directory contents");
  }
  return {
    ...match,
    manifestSha256,
    entrySha256,
    preserveReceipt: receipt !== null,
  };
}

export async function planProviderDirectoryMigration(options: {
  legacyInstallDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ProviderDirectoryMigrationPlan> {
  const env = options.env ?? process.env;
  const paths = resolveProviderLifecyclePaths(env);
  const sourceRoot = path.resolve(options.legacyInstallDir ?? paths.providersRoot);
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const planned: ProviderDirectoryMigrationEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      (sameResolvedPath(sourceRoot, paths.providersRoot) && (entry.name === "search" || entry.name === "material"))
    ) {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const sourcePrecondition = await inspectProviderReplacementPrecondition(sourcePath);
    try {
      const classified = await classifyLegacyProvider(sourcePath);
      const targetPath = providerTargetPath(classified.runtimeKind, classified.id, env);
      const targetPrecondition = await inspectProviderReplacementPrecondition(targetPath);
      const namespacePrecondition = await captureProviderNamespacePrecondition(classified.id, env);
      const namespaceOwners = namespacePresentKinds(namespacePrecondition);
      const allowedOwner = sameResolvedPath(sourceRoot, paths.providersRoot) ? "legacy" : null;
      const conflictingOwners = namespaceOwners.filter((owner) => owner !== allowedOwner);
      const mismatch = classified.id !== entry.name;
      const conflict = targetPrecondition.state === "present" || conflictingOwners.length > 0;
      planned.push({
        id: classified.id,
        runtimeKind: classified.runtimeKind,
        providerKind: classified.providerKind,
        version: classified.version,
        sourcePath,
        targetPath,
        action: mismatch || conflict ? "blocked" : "migrate",
        reason: mismatch
          ? `directory name ${entry.name} does not match manifest id ${classified.id}`
          : conflict
            ? `provider id already has a global namespace owner (${conflictingOwners.join(", ") || classified.runtimeKind})`
            : "legacy flat provider directory",
        strategy: mismatch || conflict ? null : await sameVolume(sourcePath, targetPath) ? "rename" : "copy",
        manifestSha256: classified.manifestSha256,
        entryPath: classified.entryPath,
        entrySha256: classified.entrySha256,
        sourcePrecondition,
        targetPrecondition,
        preserveReceipt: classified.preserveReceipt,
        namespacePrecondition,
      });
    } catch (error) {
      planned.push({
        id: entry.name,
        runtimeKind: null,
        providerKind: null,
        version: null,
        sourcePath,
        targetPath: null,
        action: "blocked",
        reason: error instanceof Error ? error.message : String(error),
        strategy: null,
        manifestSha256: null,
        entryPath: null,
        entrySha256: null,
        sourcePrecondition,
        targetPrecondition: null,
        preserveReceipt: false,
        namespacePrecondition: null,
      });
    }
  }
  const base = {
    schemaVersion: 1 as const,
    sourceRoot,
    targetRoot: paths.providersRoot,
    entries: planned,
  };
  return { ...base, planDigest: digest(base) };
}

function journalPath(journal: ProviderMigrationJournal, env: NodeJS.ProcessEnv): string {
  return path.join(
    resolveProviderLifecyclePaths(env).migrationStateDir,
    `provider-${createHash("sha256").update(journal.operationId).digest("hex")}.json`,
  );
}

async function writeJournal(journal: ProviderMigrationJournal, env: NodeJS.ProcessEnv): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const filePath = journalPath(journal, env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteConfigFile(filePath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function assertJournalShape(value: unknown): ProviderMigrationJournal {
  const journal = value as Partial<ProviderMigrationJournal>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.operationId !== "string" ||
    typeof journal.providerId !== "string" ||
    (journal.runtimeKind !== "search" && journal.runtimeKind !== "material") ||
    typeof journal.planDigest !== "string" ||
    typeof journal.sourceRoot !== "string" ||
    typeof journal.sourcePath !== "string" ||
    typeof journal.targetPath !== "string" ||
    typeof journal.stagingPath !== "string" ||
    (journal.strategy !== "rename" && journal.strategy !== "copy") ||
    typeof journal.sourceDigest !== "string" ||
    typeof journal.sourceHadReceipt !== "boolean" ||
    !["pending", "selected", "complete"].includes(journal.status ?? "")
  ) {
    throw new Error("Invalid provider migration recovery journal");
  }
  return journal as ProviderMigrationJournal;
}

async function pathState(targetPath: string): Promise<ProviderReplacementPrecondition> {
  return inspectProviderReplacementPrecondition(targetPath);
}

async function recoverProviderDirectoryMigrationsUnlocked(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const root = resolveProviderLifecyclePaths(env).migrationStateDir;
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const recovered: string[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.startsWith("provider-")).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(root, entry.name);
    const journal = assertJournalShape(JSON.parse(await readFile(filePath, "utf8")));
    if (path.resolve(filePath) !== path.resolve(journalPath(journal, env))) {
      throw new Error(`Provider migration journal filename does not match its operation id: ${filePath}`);
    }
    if (journal.status === "complete") continue;
    const expectedTarget = providerTargetPath(journal.runtimeKind, journal.providerId, env);
    if (
      !sameResolvedPath(journal.targetPath, expectedTarget) ||
      !sameResolvedPath(path.dirname(journal.stagingPath), path.dirname(expectedTarget)) ||
      !sameResolvedPath(path.dirname(journal.sourcePath), journal.sourceRoot)
    ) {
      throw new Error(`Unsafe provider migration recovery journal target: ${filePath}`);
    }
    const [source, staging, target] = await Promise.all([
      pathState(journal.sourcePath),
      pathState(journal.stagingPath),
      pathState(journal.targetPath),
    ]);
    if (target.state === "present") {
      const installed = await inspectProviderDirectory(journal.runtimeKind, journal.targetPath);
      const targetWithoutGeneratedReceipt = journal.sourceHadReceipt
        ? null
        : await inspectProviderPreconditionWithoutReceipt(journal.targetPath);
      const recognizedTarget = installed.healthy && installed.id === journal.providerId && (
        journal.sourceHadReceipt
          ? target.digest === journal.sourceDigest
          : installed.receipt?.installType === "legacy-directory" &&
            !installed.receipt.bound &&
            targetWithoutGeneratedReceipt?.digest === journal.sourceDigest
      );
      if (!recognizedTarget) {
        throw new Error(`Cannot recover provider migration with an unrecognized selected target: ${journal.providerId}`);
      }
      if (source.state === "present") {
        if (source.digest !== journal.sourceDigest) {
          throw new Error(`Cannot remove a changed provider migration source: ${journal.providerId}`);
        }
        await rm(journal.sourcePath, { recursive: true });
      }
      if (staging.state === "present") {
        if (staging.digest !== target.digest) {
          throw new Error(`Cannot remove changed provider migration staging: ${journal.providerId}`);
        }
        await rm(journal.stagingPath, { recursive: true });
      }
      journal.status = "complete";
      await writeJournal(journal, env);
      recovered.push(journal.providerId);
      continue;
    }
    if (staging.state === "present") {
      if (journal.strategy === "rename" && source.state === "absent") {
        if (!journal.sourceHadReceipt) {
          await rm(path.join(journal.stagingPath, ".paper-search-receipt.json"), { force: true });
          const restoredState = await pathState(journal.stagingPath);
          if (restoredState.digest !== journal.sourceDigest) {
            throw new Error(`Cannot safely restore changed provider migration staging: ${journal.providerId}`);
          }
        }
        await rename(journal.stagingPath, journal.sourcePath);
      } else if (journal.strategy === "copy" && source.state === "present") {
        await rm(journal.stagingPath, { recursive: true });
      } else {
        throw new Error(`Cannot safely recover provider migration staging state: ${journal.providerId}`);
      }
    }
    journal.status = "complete";
    await writeJournal(journal, env);
    recovered.push(journal.providerId);
  }
  return recovered;
}

async function pendingMigrationProviderIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const root = resolveProviderLifecyclePaths(env).migrationStateDir;
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const ids = new Set<string>();
  for (const entry of entries.filter((item) => item.isFile() && item.name.startsWith("provider-"))) {
    const filePath = path.join(root, entry.name);
    const journal = assertJournalShape(JSON.parse(await readFile(filePath, "utf8")));
    if (path.resolve(filePath) !== path.resolve(journalPath(journal, env))) {
      throw new Error(`Provider migration journal filename does not match its operation id: ${filePath}`);
    }
    if (journal.status !== "complete") ids.add(journal.providerId);
  }
  return [...ids].sort();
}

export async function recoverProviderDirectoryMigrations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecoveredProviderDirectoryMigrations> {
  const providerIds = await pendingMigrationProviderIds(env);
  const recovered = await withLocks(
    ["migration", ...providerIds.map((id) => `provider/${id}`)],
    () => recoverProviderDirectoryMigrationsUnlocked(env),
    { env, command: "migrate providers recover" },
  );
  const auditWarnings: string[] = [];
  for (const id of recovered) {
    const audit = await tryAppendLifecycleEvent({
      command: "migrate providers recover",
      affectedIds: [id],
      outcome: "recovered",
    }, env);
    if (audit.warning) auditWarnings.push(audit.warning);
  }
  return {
    recovered,
    ...(auditWarnings.length > 0 ? { auditWarnings } : {}),
  };
}

function migrationReceipt(entry: ProviderDirectoryMigrationEntry): ProviderInstallReceipt {
  if (
    !entry.runtimeKind || !entry.providerKind || !entry.version ||
    !entry.manifestSha256 || !entry.entryPath || !entry.entrySha256
  ) {
    throw new Error(`Incomplete provider migration receipt inputs: ${entry.id}`);
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runtimeKind: entry.runtimeKind,
    providerKind: entry.providerKind,
    id: entry.id,
    version: entry.version,
    installType: "legacy-directory",
    bound: false,
    manifestSha256: entry.manifestSha256,
    entryPath: entry.entryPath,
    entrySha256: entry.entrySha256,
    installedAt: now,
    updatedAt: now,
  };
}

async function applyMigrationEntry(
  entry: ProviderDirectoryMigrationEntry,
  plan: ProviderDirectoryMigrationPlan,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!entry.runtimeKind || !entry.targetPath || !entry.strategy || !entry.sourcePrecondition.digest) {
    throw new Error(`Provider migration entry is not actionable: ${entry.id}`);
  }
  await assertProviderReplacementPrecondition(entry.sourcePath, entry.sourcePrecondition);
  if (!entry.namespacePrecondition) throw new Error(`Provider migration namespace precondition is missing: ${entry.id}`);
  await assertProviderNamespacePrecondition(entry.id, entry.namespacePrecondition, env);
  await assertProviderReplacementPrecondition(entry.targetPath, entry.targetPrecondition ?? { state: "absent" });
  const installDir = providerInstallDir(entry.runtimeKind, env);
  await mkdir(installDir, { recursive: true });
  const stagingPath = path.join(installDir, `._migrate_${entry.id}_${randomUUID()}`);
  const now = new Date().toISOString();
  const journal: ProviderMigrationJournal = {
    schemaVersion: 1,
    operationId: randomUUID(),
    providerId: entry.id,
    runtimeKind: entry.runtimeKind,
    planDigest: plan.planDigest,
    sourceRoot: plan.sourceRoot,
    sourcePath: entry.sourcePath,
    targetPath: entry.targetPath,
    stagingPath,
    strategy: entry.strategy,
    sourceDigest: entry.sourcePrecondition.digest,
    sourceHadReceipt: entry.preserveReceipt,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await writeJournal(journal, env);
  try {
    if (entry.strategy === "rename") {
      await rename(entry.sourcePath, stagingPath);
    } else {
      await cp(entry.sourcePath, stagingPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    }
    if (!entry.preserveReceipt) await stageProviderReceipt(stagingPath, migrationReceipt(entry));
    const staged = await inspectProviderDirectory(entry.runtimeKind, stagingPath);
    if (!staged.healthy || staged.id !== entry.id) {
      throw new Error(`Migrated provider verification failed: ${entry.id}`);
    }
    if (entry.strategy === "copy") {
      await assertProviderReplacementPrecondition(entry.sourcePath, entry.sourcePrecondition);
    }
    await replaceInstallPath({
      stagingPath,
      targetPath: entry.targetPath,
      providerId: entry.id,
    });
    journal.status = "selected";
    await writeJournal(journal, env);
    if (entry.strategy === "copy") {
      await assertProviderReplacementPrecondition(entry.sourcePath, entry.sourcePrecondition);
      await rm(entry.sourcePath, { recursive: true });
    }
    journal.status = "complete";
    await writeJournal(journal, env);
  } catch (error) {
    const staging = await pathState(stagingPath);
    const target = await pathState(entry.targetPath);
    if (target.state === "absent" && staging.state === "present") {
      if (entry.strategy === "rename") {
        const source = await pathState(entry.sourcePath);
        if (source.state === "absent") {
          if (!entry.preserveReceipt) {
            await rm(path.join(stagingPath, ".paper-search-receipt.json"), { force: true });
          }
          await rename(stagingPath, entry.sourcePath);
        }
      } else {
        await rm(stagingPath, { recursive: true });
      }
    }
    throw error;
  }
}

export async function applyProviderDirectoryMigration(
  initialPlan: ProviderDirectoryMigrationPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppliedProviderDirectoryMigration> {
  const actionable = initialPlan.entries.filter((entry) => entry.action === "migrate");
  const pendingIds = await pendingMigrationProviderIds(env);
  const providerIds = [...new Set([...actionable.map((entry) => entry.id), ...pendingIds])].sort();
  const scopes = ["migration", ...providerIds.map((id) => `provider/${id}`)];
  let plan = initialPlan;
  const migrated: string[] = [];
  const recovered: string[] = [];
  let failure: unknown;
  let failed = false;
  try {
    await withLocks(scopes, async () => {
      recovered.push(...await recoverProviderDirectoryMigrationsUnlocked(env));
      plan = await planProviderDirectoryMigration({ legacyInstallDir: initialPlan.sourceRoot, env });
      if (plan.planDigest !== initialPlan.planDigest) {
        throw new Error("Provider directory migration plan became stale");
      }
      for (const entry of plan.entries) {
        if (entry.action !== "migrate") continue;
        await applyMigrationEntry(entry, plan, env);
        migrated.push(entry.id);
      }
    }, { env, command: "migrate providers" });
  } catch (error) {
    failed = true;
    failure = error;
  }

  const auditWarnings: string[] = [];
  for (const id of recovered) {
    const audit = await tryAppendLifecycleEvent({
      command: "migrate providers recover",
      affectedIds: [id],
      outcome: "recovered",
    }, env);
    if (audit.warning) auditWarnings.push(audit.warning);
  }
  for (const id of migrated) {
    const audit = await tryAppendLifecycleEvent({
      command: "migrate providers",
      planDigest: plan.planDigest,
      affectedIds: [id],
      outcome: "applied",
    }, env);
    if (audit.warning) auditWarnings.push(audit.warning);
  }
  if (failed) throw failure;
  return {
    plan,
    migrated,
    recovered,
    blocked: plan.entries.filter((entry) => entry.action === "blocked"),
    ...(auditWarnings.length > 0 ? { auditWarnings } : {}),
  };
}
