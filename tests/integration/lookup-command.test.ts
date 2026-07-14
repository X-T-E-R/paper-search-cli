import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

describe("lookup command", () => {
  it("supports lookup output as input for resource-add", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-lookup-cli-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
      ].join("\n"),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "https://example.com/paper") {
          return new Response(
            [
              "<html><head>",
              '<meta name="citation_title" content="Lookup Title" />',
              '<meta name="description" content="Lookup description." />',
              "</head><body></body></html>",
            ].join(""),
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(root);

    let lookupStdout = "";
    let lookupStderr = "";
    try {
      await buildProgram({
        stdout: { write(chunk: string) { lookupStdout += chunk; } },
        stderr: { write(chunk: string) { lookupStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "lookup",
        "https://example.com/paper",
        "--formats",
        "markdown",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(lookupStderr).toBe("");
    const lookupPath = path.join(root, "lookup.json");
    await writeFile(lookupPath, lookupStdout, "utf8");

    let addStdout = "";
    let addStderr = "";
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { addStdout += chunk; } },
        stderr: { write(chunk: string) { addStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "resource-add",
        "--item-file",
        lookupPath,
        "--collection-path",
        "Research/Inbox",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(addStderr).toBe("");
    const added = JSON.parse(addStdout);
    expect(added).toMatchObject({ ok: true, capability: "organize", tool: "resource_add" });
    expect(added.data.record.item.title).toBe("Lookup Title");
    expect(added.data.collection.path).toBe("Research/Inbox");

    const savedRecord = JSON.parse(
      await readFile(path.join(workspaceRoot, "items", `${added.data.record.id}.json`), "utf8"),
    ) as { item: { title: string } };
    expect(savedRecord.item.title).toBe("Lookup Title");
  });
});
