import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ failCollectionRename: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rename(oldPath: Parameters<typeof actual.rename>[0], newPath: Parameters<typeof actual.rename>[1]) {
      if (
        renameControl.failCollectionRename &&
        path.basename(String(newPath)) === "collections.json"
      ) {
        throw Object.assign(new Error("simulated collection rename failure"), { code: "EIO" });
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  renameControl.failCollectionRename = false;
  await Promise.all(
    tempDirs.map((dir) =>
      import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })),
    ),
  );
  tempDirs.length = 0;
});

describe("workspace collection atomic writes", () => {
  it("preserves the original index and removes the temporary file when rename fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-atomic-"));
    tempDirs.push(root);
    await addResourceToWorkspace(root, {
      item: { itemType: "journalArticle", title: "Existing item" },
      defaultCollectionPath: "Inbox",
    });
    const collectionsPath = path.join(root, "collections.json");
    const before = await readFile(collectionsPath, "utf8");

    renameControl.failCollectionRename = true;
    await expect(
      addResourceToWorkspace(root, {
        item: { itemType: "journalArticle", title: "Rejected item" },
        defaultCollectionPath: "Inbox",
      }),
    ).rejects.toThrow("simulated collection rename failure");

    await expect(readFile(collectionsPath, "utf8")).resolves.toBe(before);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
