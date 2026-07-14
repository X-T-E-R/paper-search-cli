import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "@iarna/toml";
import { atomicWriteConfigFile } from "../config/userConfig.js";
import {
  SubscriptionsConfigFileSchema,
  type SubscriptionsConfigFile,
} from "../config/schema.js";
import { identityPath, resolveSubscriptionPaths, tombstonesPath } from "./paths.js";
import { assertSubscriptionId } from "./source.js";
import type { SubscriptionIdentity, SubscriptionTombstone } from "./types.js";

interface TransactionChange {
  path: string;
  content: string | null;
  mode?: number;
}

interface RegistryOperationJournal {
  schemaVersion: 1;
  operationId: string;
  subscriptionId: string;
  command: string;
  planDigest: string;
  createdAt: string;
  status: "pending" | "complete";
  changes: TransactionChange[];
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readSubscriptionsFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionsConfigFile> {
  const raw = await readOptional(resolveSubscriptionPaths(env).subscriptionsFile);
  return raw === null
    ? { schemaVersion: 1, subscriptions: {} }
    : SubscriptionsConfigFileSchema.parse(parse(raw));
}

export function serializeSubscriptionsFile(data: SubscriptionsConfigFile): string {
  const parsed = SubscriptionsConfigFileSchema.parse(data);
  return `${stringify(parsed as unknown as Record<string, never>).trimEnd()}\n`;
}

export async function readIdentity(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionIdentity | null> {
  const raw = await readOptional(identityPath(id, env));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<SubscriptionIdentity>;
  if (
    value.schemaVersion !== 1 ||
    value.subscriptionId !== id ||
    (value.runtimeKind !== "search" && value.runtimeKind !== "material") ||
    (value.sourceType !== "https" && value.sourceType !== "local") ||
    typeof value.canonicalSource !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.configuredUrlDigest ?? "") ||
    typeof value.createdAt !== "string" ||
    !(value.latestRegistryDigest === null || /^[a-f0-9]{64}$/.test(value.latestRegistryDigest ?? ""))
  ) {
    throw new Error(`Invalid subscription identity state: ${id}`);
  }
  return value as SubscriptionIdentity;
}

export async function readTombstones(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionTombstone[]> {
  const raw = await readOptional(tombstonesPath(id, env));
  return raw === null ? [] : JSON.parse(raw) as SubscriptionTombstone[];
}

export function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function applyChanges(changes: TransactionChange[]): Promise<void> {
  for (const change of changes) {
    if (change.content === null) {
      await rm(change.path, { force: true });
    } else {
      await atomicWriteConfigFile(change.path, change.content, change.mode);
    }
  }
}

function assertSafeJournalChanges(
  subscriptionId: string,
  changes: TransactionChange[],
  env: NodeJS.ProcessEnv,
): void {
  assertSubscriptionId(subscriptionId);
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 3) {
    throw new Error(`Invalid registry operation journal change count: ${subscriptionId}`);
  }
  const allowed = new Set([
    path.resolve(resolveSubscriptionPaths(env).subscriptionsFile),
    path.resolve(identityPath(subscriptionId, env)),
    path.resolve(tombstonesPath(subscriptionId, env)),
  ].map((value) => process.platform === "win32" ? value.toLowerCase() : value));
  for (const change of changes) {
    const candidate = path.resolve(change.path);
    const comparable = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (!allowed.has(comparable) || !(change.content === null || typeof change.content === "string")) {
      throw new Error(`Unsafe registry operation journal target: ${change.path}`);
    }
  }
}

export async function recoverSubscriptionTransactions(
  subscriptionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const operationsDir = resolveSubscriptionPaths(env).operationsDir;
  const entries = await readdir(operationsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const recovered: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const journalPath = path.join(operationsDir, entry);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as RegistryOperationJournal;
    if (journal.subscriptionId !== subscriptionId || journal.status !== "pending") continue;
    assertSafeJournalChanges(subscriptionId, journal.changes, env);
    await applyChanges(journal.changes);
    journal.status = "complete";
    await atomicWriteConfigFile(journalPath, jsonContent(journal), 0o600);
    recovered.push(journal.operationId);
  }
  return recovered;
}

export async function applySubscriptionTransaction(options: {
  subscriptionId: string;
  command: string;
  planDigest: string;
  changes: TransactionChange[];
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = options.env ?? process.env;
  const operationId = randomUUID();
  assertSafeJournalChanges(options.subscriptionId, options.changes, env);
  const journal: RegistryOperationJournal = {
    schemaVersion: 1,
    operationId,
    subscriptionId: options.subscriptionId,
    command: options.command,
    planDigest: options.planDigest,
    createdAt: new Date().toISOString(),
    status: "pending",
    changes: options.changes,
  };
  const operationsDir = resolveSubscriptionPaths(env).operationsDir;
  await mkdir(operationsDir, { recursive: true });
  const journalPath = path.join(operationsDir, `${operationId}.json`);
  await atomicWriteConfigFile(journalPath, jsonContent(journal), 0o600);
  await applyChanges(options.changes);
  journal.status = "complete";
  await atomicWriteConfigFile(journalPath, jsonContent(journal), 0o600);
  return operationId;
}

interface ProviderReceipt {
  subscriptionId?: string;
  sourceFingerprint?: string;
  providerId?: string;
  id?: string;
}

export async function findDependentReceipts(
  subscriptionId: string,
  sourceFingerprint: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const root = resolveSubscriptionPaths(env).providersDir;
  const found = new Set<string>();
  const kinds = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const kind of kinds) {
    if (!kind.isDirectory()) continue;
    const providers = await readdir(path.join(root, kind.name), { withFileTypes: true });
    for (const provider of providers) {
      if (!provider.isDirectory()) continue;
      for (const filename of ["receipt.json", ".paper-search-receipt.json"]) {
        const raw = await readOptional(path.join(root, kind.name, provider.name, filename));
        if (!raw) continue;
        try {
          const receipt = JSON.parse(raw) as ProviderReceipt;
          if (
            receipt.subscriptionId === subscriptionId &&
            (!sourceFingerprint || receipt.sourceFingerprint === sourceFingerprint)
          ) {
            found.add(receipt.providerId ?? receipt.id ?? provider.name);
          }
        } catch {
          // Invalid receipts are reported elsewhere and cannot be trusted as dependency evidence.
        }
      }
    }
  }
  return [...found].sort();
}

export function subscriptionConfigChange(
  data: SubscriptionsConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): TransactionChange {
  return {
    path: resolveSubscriptionPaths(env).subscriptionsFile,
    content: serializeSubscriptionsFile(data),
  };
}

export function identityChange(
  id: string,
  identity: SubscriptionIdentity | null,
  env: NodeJS.ProcessEnv = process.env,
): TransactionChange {
  return { path: identityPath(id, env), content: identity ? jsonContent(identity) : null, mode: 0o600 };
}

export function tombstonesChange(
  id: string,
  tombstones: SubscriptionTombstone[],
  env: NodeJS.ProcessEnv = process.env,
): TransactionChange {
  return { path: tombstonesPath(id, env), content: jsonContent(tombstones), mode: 0o600 };
}
