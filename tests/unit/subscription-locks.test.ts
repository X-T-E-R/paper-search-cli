import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/subscriptions/locks.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("subscription cross-process locks", () => {
  it("times out for a live owner and reclaims a conclusively dead local owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-lock-"));
    roots.push(root);
    const env = {
      ...process.env,
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
    };
    const held = await acquireLock("subscription/alpha", { env, timeoutMs: 100 });
    await expect(acquireLock("subscription/alpha", { env, timeoutMs: 80 })).rejects.toThrow(/Timed out/);
    const lockPath = held.path;
    await held.release();
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      token: "dead-owner",
      pid: 2147483647,
      processStartedAt: new Date(0).toISOString(),
      hostname: os.hostname(),
      acquiredAt: new Date(0).toISOString(),
      command: "test",
    }));
    const reclaimed = await acquireLock("subscription/alpha", { env, timeoutMs: 200 });
    await reclaimed.release();
  });
});
