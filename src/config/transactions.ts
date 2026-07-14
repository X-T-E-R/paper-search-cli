import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "../runtime/installLayout.js";
import { withLocks } from "../runtime/locks.js";
import { applyCredentialPermissions } from "./permissions.js";
import {
  atomicWriteConfigFile,
  digestConfigContent,
  withConfigFileLocks,
} from "./userConfig.js";

export interface ConfigTransactionChange {
  path: string;
  expectedDigest: string;
  content: string;
  mode?: number;
  backupPath?: string;
}

interface ConfigTransactionJournal {
  schemaVersion: 1;
  operationId: string;
  command: string;
  planDigest: string;
  createdAt: string;
  status: "pending" | "complete";
  completedPaths: string[];
  changes: Array<ConfigTransactionChange & { resultDigest: string }>;
}

export interface ConfigTransactionResult {
  operationId: string;
  journalPath: string;
  recovered: string[];
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function transactionDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(resolveInstallPaths(env).dataRoot, "state", "config-ops");
}

function normalizeComparable(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertSafeJournal(journal: ConfigTransactionJournal, allowedPaths: readonly string[]): void {
  if (journal.schemaVersion !== 1 || !journal.operationId || !journal.planDigest) {
    throw new Error("Invalid config transaction journal header");
  }
  const allowed = new Set(allowedPaths.map(normalizeComparable));
  for (const change of journal.changes) {
    if (!allowed.has(normalizeComparable(change.path))) {
      throw new Error(`Unsafe config transaction target: ${change.path}`);
    }
    if (typeof change.content !== "string" || !/^[a-f0-9]{64}$/.test(change.expectedDigest)) {
      throw new Error(`Invalid config transaction change: ${change.path}`);
    }
    if (change.backupPath) {
      const backup = normalizeComparable(change.backupPath);
      const targetParent = normalizeComparable(path.dirname(change.path));
      if (!backup.startsWith(`${targetParent}${path.sep}`)) {
        throw new Error(`Unsafe config transaction backup: ${change.backupPath}`);
      }
    }
  }
}

async function persistJournal(filePath: string, journal: ConfigTransactionJournal): Promise<void> {
  await atomicWriteConfigFile(filePath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  await applyCredentialPermissions(filePath);
}

async function applyJournal(
  journalPath: string,
  journal: ConfigTransactionJournal,
  onChangeApplied?: (filePath: string) => Promise<void> | void,
): Promise<void> {
  for (const change of journal.changes) {
    if (journal.completedPaths.includes(change.path)) continue;
    const before = await readOptional(change.path);
    const currentDigest = digestConfigContent(before ?? "");
    if (currentDigest === change.resultDigest) {
      journal.completedPaths.push(change.path);
      await persistJournal(journalPath, journal);
      continue;
    }
    if (currentDigest !== change.expectedDigest) {
      throw new Error(`Config transaction input changed: ${change.path}`);
    }
    if (change.backupPath && before !== null) {
      const existingBackup = await readOptional(change.backupPath);
      if (existingBackup === null) {
        await atomicWriteConfigFile(change.backupPath, before, 0o600);
        await applyCredentialPermissions(change.backupPath);
      } else if (digestConfigContent(existingBackup) !== currentDigest) {
        throw new Error(`Config migration backup conflicts with source: ${change.backupPath}`);
      }
    }
    await atomicWriteConfigFile(change.path, change.content, change.mode);
    if (change.mode === 0o600) await applyCredentialPermissions(change.path);
    await onChangeApplied?.(change.path);
    journal.completedPaths.push(change.path);
    await persistJournal(journalPath, journal);
  }
  journal.status = "complete";
  await persistJournal(journalPath, journal);
}

async function pendingJournals(env: NodeJS.ProcessEnv): Promise<Array<{ path: string; journal: ConfigTransactionJournal }>> {
  const directory = transactionDirectory(env);
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const found: Array<{ path: string; journal: ConfigTransactionJournal }> = [];
  for (const name of entries.filter((entry) => entry.endsWith(".json")).sort()) {
    const filePath = path.join(directory, name);
    const journal = JSON.parse(await readFile(filePath, "utf8")) as ConfigTransactionJournal;
    if (journal.status === "pending") found.push({ path: filePath, journal });
  }
  return found;
}

async function recoverPendingUnderHeldLocks(options: {
  command: string;
  allowedPaths: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const recovered: string[] = [];
  for (const pending of await pendingJournals(options.env)) {
    if (pending.journal.command !== options.command) continue;
    assertSafeJournal(pending.journal, options.allowedPaths);
    await applyJournal(pending.path, pending.journal);
    recovered.push(pending.journal.operationId);
  }
  return recovered;
}

export async function recoverConfigTransactions(options: {
  command: string;
  allowedPaths: readonly string[];
  fileLockPaths: readonly string[];
  afterFileLockScopes?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = options.env ?? process.env;
  const recover = () => recoverPendingUnderHeldLocks({
    command: options.command,
    allowedPaths: options.allowedPaths,
    env,
  });
  return withConfigFileLocks(options.fileLockPaths, async () =>
    options.afterFileLockScopes?.length
      ? withLocks(options.afterFileLockScopes, recover, { env, command: `${options.command} recovery` })
      : recover(),
  { env, command: `${options.command} recovery` });
}

export async function applyConfigTransaction(options: {
  command: string;
  planDigest: string;
  changes: readonly ConfigTransactionChange[];
  env?: NodeJS.ProcessEnv;
  fileLockPaths?: readonly string[];
  afterFileLockScopes?: readonly string[];
  /** Test-only crash seam; production callers leave this undefined. */
  onChangeApplied?: (filePath: string) => Promise<void> | void;
}): Promise<ConfigTransactionResult> {
  const env = options.env ?? process.env;
  const targetPaths = options.changes.map((change) => change.path);
  const run = async () => {
    const recovered = await recoverPendingUnderHeldLocks({
      command: options.command,
      allowedPaths: targetPaths,
      env,
    });

    if (recovered.length > 0) {
      const requestedAlreadyApplied = (await Promise.all(options.changes.map(async (change) => {
        const current = await readOptional(change.path);
        return digestConfigContent(current ?? "") === digestConfigContent(change.content);
      }))).every(Boolean);
      if (requestedAlreadyApplied) {
        return {
          operationId: recovered.at(-1)!,
          journalPath: path.join(transactionDirectory(env), `${recovered.at(-1)!}.json`),
          recovered,
        };
      }
    }

    const operationId = randomUUID();
    const journal: ConfigTransactionJournal = {
      schemaVersion: 1,
      operationId,
      command: options.command,
      planDigest: options.planDigest,
      createdAt: new Date().toISOString(),
      status: "pending",
      completedPaths: [],
      changes: options.changes.map((change) => ({
        ...change,
        resultDigest: digestConfigContent(change.content),
      })),
    };
    assertSafeJournal(journal, targetPaths);
    const directory = transactionDirectory(env);
    await mkdir(directory, { recursive: true });
    const journalPath = path.join(directory, `${operationId}.json`);
    await persistJournal(journalPath, journal);
    await applyJournal(journalPath, journal, options.onChangeApplied);
    return { operationId, journalPath, recovered };
  };
  return withConfigFileLocks(options.fileLockPaths ?? targetPaths, async () =>
    options.afterFileLockScopes?.length
      ? withLocks(options.afterFileLockScopes, run, { env, command: options.command })
      : run(),
  { env, command: options.command });
}
