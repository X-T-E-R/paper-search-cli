import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderDirectoryInspection } from "./inventory.js";
import {
  inspectProviderReplacementPrecondition,
  type ProviderReplacementPrecondition,
  type ProviderRuntimeKind,
} from "./install/manualZip.js";
import { removeInstallPath } from "./install/cleanup.js";
import type { InstallPathRetention } from "./install/replace.js";

const ROLLBACK_ROOT_NAME = ".paper-search-rollbacks";
const ROLLBACK_RECORD_FILENAME = "rollback.json";
const SHA256_RE = /^[a-f0-9]{64}$/;

export type ProviderRollbackReason = "replace-bound-zip" | "uninstall" | "rollback-displaced";

export interface ProviderRollbackReference {
  schemaVersion: 1;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  revision: string;
  rootPath: string;
  providerPath: string;
  recordPath: string;
}

interface ProviderRollbackRecord {
  schemaVersion: 1;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  revision: string;
  providerDirectory: "provider";
  retainedAt: string;
  reason: ProviderRollbackReason;
}

export interface PreparedProviderRollbackRetention {
  reference: ProviderRollbackReference;
  reused: boolean;
  retention?: InstallPathRetention;
  cleanup(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function rollbackRoot(installDir: string, id: string, revision: string): string {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) throw new Error(`Invalid provider id: ${id}`);
  if (!SHA256_RE.test(revision)) throw new Error(`Invalid provider rollback revision: ${revision}`);
  return path.join(path.resolve(installDir), ROLLBACK_ROOT_NAME, id, revision);
}

function referenceFromIdentity(options: {
  installDir: string;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  revision: string;
}): ProviderRollbackReference {
  const rootPath = rollbackRoot(options.installDir, options.id, options.revision);
  return {
    schemaVersion: 1,
    runtimeKind: options.runtimeKind,
    providerKind: options.providerKind,
    id: options.id,
    version: options.version,
    revision: options.revision,
    rootPath,
    providerPath: path.join(rootPath, "provider"),
    recordPath: path.join(rootPath, ROLLBACK_RECORD_FILENAME),
  };
}

export function createProviderRollbackReference(options: {
  installDir: string;
  inspection: ProviderDirectoryInspection;
  precondition: ProviderReplacementPrecondition;
}): ProviderRollbackReference {
  if (options.precondition.state !== "present" || !options.precondition.digest) {
    throw new Error(`Provider ${options.inspection.id} has no installed revision to retain`);
  }
  return referenceFromIdentity({
    installDir: options.installDir,
    runtimeKind: options.inspection.runtimeKind,
    providerKind: options.inspection.providerKind,
    id: options.inspection.id,
    version: options.inspection.version,
    revision: options.precondition.digest,
  });
}

function parseRollbackRecord(raw: string, recordPath: string): ProviderRollbackRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in provider rollback record: ${recordPath}`, { cause: error });
  }
  const record = value as Partial<ProviderRollbackRecord>;
  if (
    record.schemaVersion !== 1 ||
    (record.runtimeKind !== "search" && record.runtimeKind !== "material") ||
    typeof record.providerKind !== "string" ||
    typeof record.id !== "string" ||
    typeof record.version !== "string" ||
    !SHA256_RE.test(record.revision ?? "") ||
    record.providerDirectory !== "provider" ||
    typeof record.retainedAt !== "string" ||
    !["replace-bound-zip", "uninstall", "rollback-displaced"].includes(record.reason ?? "")
  ) {
    throw new Error(`Invalid provider rollback record: ${recordPath}`);
  }
  return record as ProviderRollbackRecord;
}

function assertRecordMatchesReference(
  record: ProviderRollbackRecord,
  reference: ProviderRollbackReference,
): void {
  for (const key of ["runtimeKind", "providerKind", "id", "version", "revision"] as const) {
    if (record[key] !== reference[key]) {
      throw new Error(`Provider rollback record does not match ${key}: ${reference.recordPath}`);
    }
  }
}

export async function assertProviderRollbackReady(
  reference: ProviderRollbackReference,
): Promise<void> {
  const record = parseRollbackRecord(
    await readFile(reference.recordPath, "utf8"),
    reference.recordPath,
  );
  assertRecordMatchesReference(record, reference);
  const state = await inspectProviderReplacementPrecondition(reference.providerPath);
  if (state.state !== "present" || state.digest !== reference.revision) {
    throw new Error(`Provider rollback revision changed: ${reference.revision}`);
  }
}

export async function loadProviderRollbackReference(options: {
  installDir: string;
  id: string;
  revision: string;
}): Promise<ProviderRollbackReference> {
  const rootPath = rollbackRoot(options.installDir, options.id, options.revision);
  const recordPath = path.join(rootPath, ROLLBACK_RECORD_FILENAME);
  const record = parseRollbackRecord(await readFile(recordPath, "utf8"), recordPath);
  if (record.id !== options.id || record.revision !== options.revision) {
    throw new Error(`Provider rollback selector does not match record: ${recordPath}`);
  }
  const reference = referenceFromIdentity({
    installDir: options.installDir,
    runtimeKind: record.runtimeKind,
    providerKind: record.providerKind,
    id: record.id,
    version: record.version,
    revision: record.revision,
  });
  await assertProviderRollbackReady(reference);
  return reference;
}

export async function prepareProviderRollbackRetention(options: {
  reference: ProviderRollbackReference;
  reason: ProviderRollbackReason;
}): Promise<PreparedProviderRollbackRetention> {
  if (await pathExists(options.reference.rootPath)) {
    await assertProviderRollbackReady(options.reference);
    return {
      reference: options.reference,
      reused: true,
      cleanup: async () => undefined,
    };
  }

  const revisionRoot = path.dirname(options.reference.rootPath);
  await mkdir(revisionRoot, { recursive: true });
  const stagingRoot = await mkdtemp(
    path.join(revisionRoot, `.${options.reference.revision}.pending.`),
  );
  const record: ProviderRollbackRecord = {
    schemaVersion: 1,
    runtimeKind: options.reference.runtimeKind,
    providerKind: options.reference.providerKind,
    id: options.reference.id,
    version: options.reference.version,
    revision: options.reference.revision,
    providerDirectory: "provider",
    retainedAt: new Date().toISOString(),
    reason: options.reason,
  };
  await writeFile(
    path.join(stagingRoot, ROLLBACK_RECORD_FILENAME),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return {
    reference: options.reference,
    reused: false,
    retention: { stagingRoot, finalRoot: options.reference.rootPath },
    cleanup: async () => removeInstallPath(stagingRoot).catch(() => undefined),
  };
}

export async function retainProviderForUninstall(options: {
  targetPath: string;
  prepared: PreparedProviderRollbackRetention;
}): Promise<void> {
  const targetPath = path.resolve(options.targetPath);
  if (options.prepared.reused) {
    const discardPath = path.join(
      path.dirname(targetPath),
      `.${options.prepared.reference.id}.uninstall.${randomUUID()}`,
    );
    await rename(targetPath, discardPath);
    try {
      await removeInstallPath(discardPath);
    } catch (removeError) {
      try {
        await rename(discardPath, targetPath);
      } catch (restoreError) {
        throw new AggregateError(
          [removeError, restoreError],
          `Failed to uninstall ${options.prepared.reference.id} and restore its provider directory`,
        );
      }
      throw removeError;
    }
    return;
  }

  const retention = options.prepared.retention!;
  const stagedProviderPath = path.join(retention.stagingRoot, "provider");
  await rename(targetPath, stagedProviderPath);
  let restorableProviderPath = stagedProviderPath;
  try {
    await rename(retention.stagingRoot, retention.finalRoot);
    restorableProviderPath = options.prepared.reference.providerPath;
    await assertProviderRollbackReady(options.prepared.reference);
  } catch (retainError) {
    try {
      await rename(restorableProviderPath, targetPath);
    } catch (restoreError) {
      throw new AggregateError(
        [retainError, restoreError],
        `Failed to uninstall ${options.prepared.reference.id} and restore its provider directory`,
      );
    }
    await removeInstallPath(retention.finalRoot).catch(() => undefined);
    await options.prepared.cleanup();
    throw retainError;
  }
}

export async function removeConsumedProviderRollback(
  reference: ProviderRollbackReference,
): Promise<string | undefined> {
  try {
    await removeInstallPath(reference.rootPath);
    return undefined;
  } catch (error) {
    return `Rollback succeeded, but consumed rollback metadata could not be removed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
