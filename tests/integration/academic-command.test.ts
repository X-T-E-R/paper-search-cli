import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

describe("academic command", () => {
  it("searches installed academic providers through the local runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-academic-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    await mkdir(path.join(installDir, "fixture-academic-searchable"), { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      ["[providers]", `installDir = \"${installDir.replace(/\\/g, "\\\\")}\"`, ""].join("\n"),
      "utf8",
    );
    const fixtureDir = path.resolve(
      "tests",
      "fixtures",
      "provider-packages",
      "fixture-academic-searchable",
    );
    await writeFile(
      path.join(installDir, "fixture-academic-searchable", "manifest.json"),
      await readFile(path.join(fixtureDir, "manifest.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "fixture-academic-searchable", "provider.js"),
      await readFile(path.join(fixtureDir, "provider.js"), "utf8"),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync(["node", "paper-search", "academic", "rag evaluation"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "discover",
      tool: "academic_search",
    });
    expect(parsed.data.platform).toBe("fixture-academic-searchable");
    expect(parsed.data.items).toHaveLength(2);
  });
});
