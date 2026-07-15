import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    }).exitOverride().parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(originalCwd);
  }
  return { stdout, stderr };
}

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

describe("workspace commands", () => {
  it("adds a resource to the workspace sink and lists collections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-cli-"));
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

    let addStdout = "";
    let addStderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { addStdout += chunk; } },
        stderr: { write(chunk: string) { addStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "resource-add",
        "--url",
        "https://example.com/resource",
        "--title",
        "Example Resource",
        "--collection-path",
        "Research/Inbox",
        "--tags",
        "alpha,beta",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(addStderr).toBe("");
    const added = JSON.parse(addStdout);
    expect(added).toMatchObject({ ok: true, capability: "organize", tool: "resource_add" });
    expect(added.data.collection.path).toBe("Research/Inbox");
    expect(added.data.record.fetchPdfRequested).toBe(false);

    let listStdout = "";
    let listStderr = "";
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { listStdout += chunk; } },
        stderr: { write(chunk: string) { listStderr += chunk; } },
      }).parseAsync(["node", "paper-search", "collection-list", "--flat", "--json"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(listStderr).toBe("");
    const listed = JSON.parse(listStdout);
    expect(listed).toMatchObject({ ok: true, capability: "organize", tool: "collection_list" });
    expect(listed.data.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Inbox" }),
        expect.objectContaining({ path: "Research" }),
        expect.objectContaining({ path: "Research/Inbox", itemCount: 1 }),
      ]),
    );

    const exportPath = path.join(root, "workspace-export.jsonl");
    let exportStdout = "";
    let exportStderr = "";
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { exportStdout += chunk; } },
        stderr: { write(chunk: string) { exportStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "workspace-export",
        "--collection-path",
        "Research",
        "--include-children",
        "--out",
        exportPath,
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(exportStderr).toBe("");
    const exported = JSON.parse(exportStdout);
    expect(exported).toMatchObject({
      ok: true,
      capability: "organize",
      tool: "workspace_export",
      data: {
        out: exportPath,
        format: "jsonl",
        count: 1,
        collectionPath: "Research",
        includeChildren: true,
      },
    });
    const exportedLines = (await readFile(exportPath, "utf8")).trim().split("\n");
    expect(exportedLines).toHaveLength(1);
    expect(JSON.parse(exportedLines[0]!)).toMatchObject({
      collectionPath: "Research/Inbox",
      item: expect.objectContaining({ title: "Example Resource" }),
    });
  });

  it("emits ResultEnvelope JSON on stdout for JSON and JSONL exports without --out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-export-stdout-"));
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

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      let addStdout = "";
      let addStderr = "";
      await buildProgram({
        stdout: { write(chunk: string) { addStdout += chunk; } },
        stderr: { write(chunk: string) { addStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "resource-add",
        "--url",
        "https://example.com/export-envelope",
        "--title",
        "Envelope Export Resource",
        "--collection-path",
        "Research/Inbox",
        "--json",
      ]);
      expect(addStderr).toBe("");
      expect(JSON.parse(addStdout)).toMatchObject({ ok: true, tool: "resource_add" });

      let jsonStdout = "";
      let jsonStderr = "";
      await buildProgram({
        stdout: { write(chunk: string) { jsonStdout += chunk; } },
        stderr: { write(chunk: string) { jsonStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "workspace-export",
        "--collection-path",
        "Research",
        "--include-children",
      ]);
      expect(jsonStderr).toBe("");
      const jsonEnvelope = JSON.parse(jsonStdout);
      expect(jsonEnvelope).toMatchObject({
        ok: true,
        capability: "organize",
        tool: "workspace_export",
        data: {
          format: "json",
          count: 1,
          collectionPath: "Research",
          includeChildren: true,
        },
      });
      expect(JSON.parse(jsonEnvelope.data.content)).toMatchObject({
        format: "json",
        count: 1,
        collectionPath: "Research",
        includeChildren: true,
        items: [
          expect.objectContaining({
            collectionPath: "Research/Inbox",
            item: expect.objectContaining({ title: "Envelope Export Resource" }),
          }),
        ],
      });

      let jsonlStdout = "";
      let jsonlStderr = "";
      await buildProgram({
        stdout: { write(chunk: string) { jsonlStdout += chunk; } },
        stderr: { write(chunk: string) { jsonlStderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "workspace-export",
        "--format",
        "jsonl",
        "--collection-path",
        "Research",
        "--include-children",
      ]);
      expect(jsonlStderr).toBe("");
      const jsonlEnvelope = JSON.parse(jsonlStdout);
      expect(jsonlEnvelope).toMatchObject({
        ok: true,
        capability: "organize",
        tool: "workspace_export",
        data: {
          format: "jsonl",
          count: 1,
          collectionPath: "Research",
          includeChildren: true,
        },
      });
      const jsonlLines = String(jsonlEnvelope.data.content).trim().split("\n");
      expect(jsonlLines).toHaveLength(1);
      expect(JSON.parse(jsonlLines[0]!)).toMatchObject({
        collectionPath: "Research/Inbox",
        item: expect.objectContaining({ title: "Envelope Export Resource" }),
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("writes --store exports through the configured managed export root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-store-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const exportRoot = path.join(root, "configured-exports");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `exportRoot = \"${exportRoot.replace(/\\/g, "\\\\")}\"`,
        "",
      ].join("\n"),
      "utf8",
    );

    await runCli(root, [
      "resource-add",
      "--url",
      "https://example.com/managed-export",
      "--title",
      "Managed Export Resource",
      "--json",
    ]);

    const stored = await runCli(root, [
      "workspace-export",
      "--store",
      "reports/research.jsonl",
      "--json",
    ]);
    expect(stored.stderr).toBe("");
    const envelope = JSON.parse(stored.stdout);
    const expectedPath = path.join(exportRoot, "reports", "research.jsonl");
    expect(envelope).toMatchObject({
      ok: true,
      capability: "organize",
      tool: "workspace_export",
      data: {
        out: expectedPath,
        format: "jsonl",
        count: 1,
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "export",
          root: exportRoot,
          key: "reports/research.jsonl",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          sizeBytes: expect.any(Number),
        },
      },
      diagnostics: {
        exportRoot,
        out: expectedPath,
      },
    });
    expect((await readFile(expectedPath, "utf8")).trim()).toContain("Managed Export Resource");
  });

  it("plans --store without writing and rejects unsafe keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-store-plan-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const exportRoot = path.join(root, "not-created-exports");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `exportRoot = \"${exportRoot.replace(/\\/g, "\\\\")}\"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const planned = await runCli(root, [
      "workspace-export",
      "--store",
      "plans/export.csv",
      "--dry-run",
      "--json",
    ]);
    expect(planned.stderr).toBe("");
    expect(JSON.parse(planned.stdout)).toMatchObject({
      ok: true,
      planned: true,
      capability: "organize",
      tool: "workspace_export",
      data: {
        out: path.join(exportRoot, "plans", "export.csv"),
        format: "csv",
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "export",
          root: exportRoot,
          key: "plans/export.csv",
        },
      },
    });
    await expect(readFile(path.join(exportRoot, "plans", "export.csv"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(exportRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const outside = path.join(root, "outside-exports");
    await mkdir(exportRoot);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(exportRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(runCli(root, [
      "workspace-export",
      "--store",
      "linked/not-created/export.json",
      "--dry-run",
      "--json",
    ])).rejects.toThrow("Local storage parent must be a real directory: linked");
    await expect(stat(path.join(outside, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(runCli(root, [
      "workspace-export",
      "--store",
      "../escape.json",
      "--dry-run",
      "--json",
    ])).rejects.toThrow("Unsafe local storage key");
    for (const unsafeKey of ["reports/report.json:stream", "reports/CON", "reports/trailing."]) {
      await expect(runCli(root, [
        "workspace-export",
        "--store",
        unsafeKey,
        "--dry-run",
        "--json",
      ])).rejects.toThrow("Unsafe local storage key");
    }
    await expect(readFile(path.join(root, "escape.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects --store collisions atomically and forbids combining --store with --out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-workspace-store-collision-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const exportRoot = path.join(root, "exports");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `exportRoot = \"${exportRoot.replace(/\\/g, "\\\\")}\"`,
        "",
      ].join("\n"),
      "utf8",
    );

    await runCli(root, ["workspace-export", "--store", "stable/export.json", "--json"]);
    const storedPath = path.join(exportRoot, "stable", "export.json");
    const original = await readFile(storedPath, "utf8");
    await expect(runCli(root, [
      "workspace-export",
      "--store",
      "stable/export.json",
      "--json",
    ])).rejects.toThrow("Local storage target already exists");
    await expect(runCli(root, [
      "workspace-export",
      "--store",
      "stable/export.json",
      "--dry-run",
      "--json",
    ])).rejects.toThrow("Local storage target already exists");
    expect(await readFile(storedPath, "utf8")).toBe(original);

    const explicitOut = path.join(root, "explicit.json");
    await expect(runCli(root, [
      "workspace-export",
      "--store",
      "other/export.json",
      "--out",
      explicitOut,
    ])).rejects.toThrow("--store and --out are mutually exclusive");
    await expect(readFile(explicitOut, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
