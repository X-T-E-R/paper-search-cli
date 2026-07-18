import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInstallPaths } from "./installLayout.js";

interface LockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  processStartedAt: string;
  hostname: string;
  acquiredAt: string;
  command: string;
}

export interface HeldLock {
  scope: string;
  path: string;
  token: string;
  release(): Promise<void>;
}

export interface LockOptions {
  env?: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  /** Test/embedding seam. Production locks live under the resolved data root. */
  lockRoot?: string;
}

function lockPath(scope: string, options: LockOptions): string {
  const parts = scope.split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid lock scope: ${scope}`);
  }
  const safeParts = parts.map((part) => encodeURIComponent(part));
  const root = options.lockRoot ?? path.join(resolveInstallPaths(options.env ?? process.env).dataRoot, "state", "locks");
  return path.join(root, ...safeParts.slice(0, -1), `${safeParts.at(-1)}.lock`);
}

function currentProcessStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1_000).toISOString();
}

async function ownerIsConclusivelyDead(owner: LockOwner): Promise<boolean> {
  if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const owner = JSON.parse(raw) as Partial<LockOwner>;
    if (
      owner.schemaVersion !== 1 ||
      typeof owner.token !== "string" ||
      typeof owner.pid !== "number" ||
      typeof owner.processStartedAt !== "string" ||
      typeof owner.hostname !== "string" ||
      typeof owner.acquiredAt !== "string" ||
      typeof owner.command !== "string"
    ) return null;
    return owner as LockOwner;
  } catch {
    return null;
  }
}

export async function acquireLock(scope: string, options: LockOptions = {}): Promise<HeldLock> {
  const filePath = lockPath(scope, options);
  await mkdir(path.dirname(filePath), { recursive: true });
  const token = randomUUID();
  const owner: LockOwner = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    processStartedAt: currentProcessStartedAt(),
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    command: options.command ?? process.argv.slice(2).join(" "),
  };
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);

  for (;;) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        scope,
        path: filePath,
        token,
        async release() {
          let raw: string;
          try {
            raw = await readFile(filePath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          const current = parseOwner(raw);
          if (!current || current.token !== token) {
            throw new Error(`Refusing to release lock owned by another process: ${scope}`);
          }
          await rm(filePath);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report a sharing violation as EPERM while another owner
      // is creating or replacing the lock file. Treat it like contention and
      // let the ownership read/deadline path below decide whether to retry.
      if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) {
        throw error;
      }
    }

    try {
      const raw = await readFile(filePath, "utf8");
      const current = parseOwner(raw);
      // Malformed or incomplete ownership evidence is intentionally never reclaimed.
      if (current && await ownerIsConclusivelyDead(current)) {
        const quarantinePath = `${filePath}.stale-${randomUUID()}`;
        try {
          await rename(filePath, quarantinePath);
          const quarantined = parseOwner(await readFile(quarantinePath, "utf8"));
          if (quarantined?.token !== current.token) {
            await rename(quarantinePath, filePath).catch(() => undefined);
            continue;
          }
          await rm(quarantinePath, { force: true });
          continue;
        } catch (renameError) {
          const code = (renameError as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EEXIST") continue;
          throw renameError;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${scope}`);
    await sleep(40);
  }
}

export async function withLocks<T>(
  scopes: readonly string[],
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const held: HeldLock[] = [];
  try {
    for (const scope of scopes) held.push(await acquireLock(scope, options));
    return await action();
  } finally {
    for (const lock of held.reverse()) await lock.release();
  }
}
