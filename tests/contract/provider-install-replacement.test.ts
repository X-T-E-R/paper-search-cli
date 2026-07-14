import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceInstallPath,
  type InstallPathReplacementOperations,
} from "../../src/providers/install/replace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("provider install replacement transaction", () => {
  it("restores the prior provider when selecting staged content fails", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-provider-replace-")),
    );
    tempDirs.push(root);
    const targetPath = path.join(root, "alpha");
    const stagingPath = path.join(root, "._install_alpha");
    await mkdir(targetPath);
    await mkdir(stagingPath);
    await writeFile(path.join(targetPath, "marker.txt"), "prior", "utf8");
    await writeFile(path.join(stagingPath, "marker.txt"), "new", "utf8");

    const operations: InstallPathReplacementOperations = {
      stat,
      remove: (target) => rm(target, { recursive: true, force: true }),
      async rename(source, destination) {
        if (path.resolve(source) === stagingPath && path.resolve(destination) === targetPath) {
          const error = new Error("simulated staged rename failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        await rename(source, destination);
      },
    };

    await expect(
      replaceInstallPath({ stagingPath, targetPath, providerId: "alpha", operations }),
    ).rejects.toThrow("simulated staged rename failure");
    await expect(readFile(path.join(targetPath, "marker.txt"), "utf8")).resolves.toBe("prior");
  });
});
