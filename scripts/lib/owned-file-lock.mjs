import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseOwner(raw) {
  try {
    const owner = JSON.parse(raw);
    if (
      owner?.schemaVersion !== 1 ||
      typeof owner.token !== "string" ||
      !Number.isInteger(owner.pid) ||
      typeof owner.processStartedAt !== "string" ||
      typeof owner.hostname !== "string" ||
      typeof owner.acquiredAt !== "string" ||
      typeof owner.command !== "string"
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(filePath) {
  try {
    return parseOwner(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertOwnedFileLock(filePath, token) {
  if (typeof token !== "string" || !token) {
    throw new Error(`A held lock token is required for ${filePath}`);
  }
  const owner = await readOwner(filePath);
  if (!owner || owner.token !== token) {
    throw new Error(`The held lock token does not own ${filePath}`);
  }
  return owner;
}

export async function acquireOwnedFileLock(
  filePath,
  { timeoutMs = 30_000, command = "paper-search" } = {},
) {
  const owner = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    command,
  };
  const started = Date.now();
  await mkdir(path.dirname(filePath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: filePath,
        token: owner.token,
        owner,
        async release() {
          if (released) return;
          const current = await readOwner(filePath);
          if (current && current.token !== owner.token) {
            throw new Error(`Refusing to release a lock owned by another process: ${filePath}`);
          }
          if (current) await unlink(filePath);
          released = true;
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const current = await readOwner(filePath).catch(() => null);
    const canRecover =
      current?.hostname === owner.hostname &&
      Number.isInteger(current?.pid) &&
      !processIsAlive(current.pid);
    if (canRecover) {
      const quarantinePath = `${filePath}.stale-${randomUUID()}`;
      try {
        await rename(filePath, quarantinePath);
        const quarantined = await readOwner(quarantinePath);
        if (quarantined?.token !== current.token) {
          await rename(quarantinePath, filePath).catch(() => undefined);
          continue;
        }
        await rm(quarantinePath, { force: true });
        continue;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EEXIST") continue;
        throw error;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for lock ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
