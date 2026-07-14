import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rename(oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) {
      if (renameControl.fail && path.basename(String(newPath)) === "config.toml") {
        throw Object.assign(new Error("simulated config rename failure"), { code: "EIO" });
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import { readUserConfigFile, writeUserConfigFile } from "../../src/config/userConfig.js";

const tempDirs: string[] = [];

afterEach(async () => {
  renameControl.fail = false;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("atomic config writes", () => {
  it("preserves the original file and removes the temporary file when rename fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-atomic-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    const lockRoot = path.join(root, "locks");
    await writeUserConfigFile({ defaults: { maxResults: 11 } }, configPath, { lockRoot });
    const before = await readFile(configPath, "utf8");
    const current = await readUserConfigFile(configPath);

    renameControl.fail = true;
    await expect(
      writeUserConfigFile({ defaults: { maxResults: 22 } }, configPath, {
        expectedDigest: current.digest,
        lockRoot,
      }),
    ).rejects.toThrow("simulated config rename failure");

    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a stale planned digest before replacing the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-digest-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.toml");
    const lockRoot = path.join(root, "locks");
    await writeUserConfigFile({ defaults: { maxResults: 11 } }, configPath, { lockRoot });
    const stale = await readUserConfigFile(configPath);
    await writeUserConfigFile({ defaults: { maxResults: 22 } }, configPath, { lockRoot });

    await expect(
      writeUserConfigFile({ defaults: { maxResults: 33 } }, configPath, {
        expectedDigest: stale.digest,
        lockRoot,
      }),
    ).rejects.toThrow("changed since it was read");
    await expect(readFile(configPath, "utf8")).resolves.toContain("maxResults = 22");
  });
});
