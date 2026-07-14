import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "./installLayout.js";
import { withLocks } from "../subscriptions/locks.js";

export type LifecycleEventOutcome = "applied" | "recovered";

export interface LifecycleEventInput {
  operationId?: string;
  command: string;
  planDigest?: string;
  affectedIds: string[];
  sourceFingerprint?: string;
  registryDigest?: string;
  archiveSha256?: string;
  outcome: LifecycleEventOutcome;
}

export interface LifecycleEventRecord extends LifecycleEventInput {
  schemaVersion: 1;
  eventId: string;
  operationId: string;
  timestamp: string;
}

export interface LifecycleEventAppendResult {
  event: LifecycleEventRecord | null;
  path: string;
  warning?: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function assertOptionalDigest(value: string | undefined, label: string): void {
  if (value !== undefined && !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizeEvent(input: LifecycleEventInput, timestamp: string): LifecycleEventRecord {
  const command = input.command.trim();
  if (!command || /[\r\n\0]/u.test(command)) {
    throw new Error("Lifecycle event command must be a non-empty single line");
  }
  if (!Array.isArray(input.affectedIds) || input.affectedIds.some((id) => !ID_RE.test(id))) {
    throw new Error("Lifecycle event affectedIds contains an invalid provider or subscription id");
  }
  assertOptionalDigest(input.planDigest, "planDigest");
  assertOptionalDigest(input.sourceFingerprint, "sourceFingerprint");
  assertOptionalDigest(input.registryDigest, "registryDigest");
  assertOptionalDigest(input.archiveSha256, "archiveSha256");
  const operationId = input.operationId ?? randomUUID();
  if (!operationId || /[\r\n\0]/u.test(operationId)) {
    throw new Error("Lifecycle event operationId is invalid");
  }
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    operationId,
    timestamp,
    command,
    affectedIds: [...new Set(input.affectedIds)].sort(),
    outcome: input.outcome,
    ...(input.planDigest ? { planDigest: input.planDigest } : {}),
    ...(input.sourceFingerprint ? { sourceFingerprint: input.sourceFingerprint } : {}),
    ...(input.registryDigest ? { registryDigest: input.registryDigest } : {}),
    ...(input.archiveSha256 ? { archiveSha256: input.archiveSha256 } : {}),
  };
}

function eventMonth(timestamp: string): string {
  return timestamp.slice(0, 7);
}

export function lifecycleEventPath(
  timestamp = new Date().toISOString(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveInstallPaths(env).dataRoot, "state", "events", `${eventMonth(timestamp)}.jsonl`);
}

/**
 * Append after authoritative mutation locks have been released. This function
 * acquires only the monthly event lock and never owns provider/subscription
 * state, so callers can report an audit warning without rolling back state.
 */
export async function appendLifecycleEvent(
  input: LifecycleEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LifecycleEventAppendResult> {
  const timestamp = new Date().toISOString();
  const event = normalizeEvent(input, timestamp);
  const filePath = lifecycleEventPath(timestamp, env);
  await withLocks(
    [`event/${eventMonth(timestamp)}`],
    async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    },
    { env, command: "event append" },
  );
  return { event, path: filePath };
}

export async function tryAppendLifecycleEvent(
  input: LifecycleEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LifecycleEventAppendResult> {
  const filePath = lifecycleEventPath(new Date().toISOString(), env);
  try {
    return await appendLifecycleEvent(input, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      event: null,
      path: filePath,
      warning: `Authoritative state was applied, but the lifecycle event could not be recorded: ${message}`,
    };
  }
}
