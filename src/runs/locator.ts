import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import { resolvePaperSearchPaths } from "../config/home.js";
import { withLocks } from "../runtime/locks.js";
import { assertRunId } from "./store.js";

const LOCATOR_SCHEMA_VERSION = 1;
const LOCATOR_LIMIT = 8 * 1024;

export interface RunLocator {
  schemaVersion: typeof LOCATOR_SCHEMA_VERSION;
  runId: string;
  contextId: string;
  contextKind: "standalone" | "paperflow";
  runRoot: string;
}

function locatorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaperSearchPaths(env).stateRoot, "run-locations");
}

function locatorPath(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertRunId(runId);
  return path.join(locatorRoot(env), `${runId}.json`);
}

function parseLocator(value: unknown, expectedRunId: string): RunLocator {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Run locator is not an object: ${expectedRunId}`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => ![
      "schemaVersion", "runId", "contextId", "contextKind", "runRoot",
    ].includes(key)) ||
    record.schemaVersion !== LOCATOR_SCHEMA_VERSION ||
    record.runId !== expectedRunId ||
    typeof record.contextId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.contextId) ||
    (record.contextKind !== "standalone" && record.contextKind !== "paperflow") ||
    typeof record.runRoot !== "string" ||
    !path.isAbsolute(record.runRoot) ||
    path.resolve(record.runRoot) !== record.runRoot
  ) {
    throw new Error(`Run locator is invalid: ${expectedRunId}`);
  }
  return record as unknown as RunLocator;
}

export async function readRunLocator(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunLocator | null> {
  const file = locatorPath(runId, env);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > LOCATOR_LIMIT) {
    throw new Error(`Run locator is unsafe or oversized: ${runId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Run locator is corrupt: ${runId}`, { cause: error });
  }
  return parseLocator(parsed, runId);
}

export async function registerRunLocator(
  config: ResolvedConfig,
  runId: string,
  runRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = resolvePaperSearchPaths(env);
  if (
    config.context.kind === "global" ||
    path.resolve(runRoot) === path.resolve(paths.runsRoot)
  ) return;
  assertRunId(runId);
  if (!path.isAbsolute(runRoot)) throw new Error("Run locator root must be absolute");
  const record: RunLocator = {
    schemaVersion: LOCATOR_SCHEMA_VERSION,
    runId,
    contextId: config.context.id,
    contextKind: config.context.kind as RunLocator["contextKind"],
    runRoot: path.resolve(runRoot),
  };
  const root = locatorRoot(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Run locator root is not a regular directory");
  }
  await withLocks([`run-locator/${runId}`], async () => {
    const existing = await readRunLocator(runId, env);
    if (existing) {
      if (
        existing.runId === record.runId &&
        existing.contextId === record.contextId &&
        existing.contextKind === record.contextKind &&
        existing.runRoot === record.runRoot
      ) return;
      throw new Error(`Run locator already points to another context: ${runId}`);
    }
    const target = locatorPath(runId, env);
    const temporary = path.join(root, `.${runId}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }, {
    lockRoot: path.join(paths.stateRoot, "locks"),
    command: `register run locator ${runId}`,
  });
}
