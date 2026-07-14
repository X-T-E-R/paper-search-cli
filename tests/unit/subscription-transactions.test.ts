import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { identityPath, resolveSubscriptionPaths } from "../../src/subscriptions/paths.js";
import { recoverSubscriptionTransactions } from "../../src/subscriptions/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("subscription transaction recovery", () => {
  it("idempotently completes pending paired writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registry-recovery-"));
    roots.push(root);
    const env = {
      ...process.env,
      APPDATA: path.join(root, "appdata"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
    };
    const paths = resolveSubscriptionPaths(env);
    expect(paths.subscriptionsFile).toBe(path.join(root, "data", "subscriptions.toml"));
    await mkdir(paths.operationsDir, { recursive: true });
    const first = paths.subscriptionsFile;
    const second = identityPath("alpha", env);
    const journalPath = path.join(paths.operationsDir, "interrupted.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      operationId: "interrupted",
      subscriptionId: "alpha",
      command: "registries add",
      planDigest: "digest",
      createdAt: new Date().toISOString(),
      status: "pending",
      changes: [
        { path: first, content: "first\n" },
        { path: second, content: "second\n" },
      ],
    }));

    await expect(recoverSubscriptionTransactions("alpha", env)).resolves.toEqual(["interrupted"]);
    await expect(readFile(first, "utf8")).resolves.toBe("first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("second\n");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "complete" });
    await expect(recoverSubscriptionTransactions("alpha", env)).resolves.toEqual([]);

    await writeFile(path.join(paths.operationsDir, "unsafe.json"), JSON.stringify({
      schemaVersion: 1,
      operationId: "unsafe",
      subscriptionId: "alpha",
      command: "registries add",
      planDigest: "digest",
      createdAt: new Date().toISOString(),
      status: "pending",
      changes: [{ path: path.join(root, "outside.txt"), content: "unsafe" }],
    }));
    await expect(recoverSubscriptionTransactions("alpha", env)).rejects.toThrow(/Unsafe/);
  });
});
