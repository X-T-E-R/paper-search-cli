import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  let stdout = "";
  const program = buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(_chunk: string) {} },
  }).exitOverride();
  await program.parseAsync(["node", "paper-search", ...args]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("context commands", () => {
  it("initializes a standalone context once and reports its compact status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-context-command-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const originalHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = home;
    try {
      const initialized = await runCli(["context", "init", project, "--id", "review-a"]);
      expect(initialized).toMatchObject({
        ok: true,
        tool: "context_init",
        data: {
          context: { id: "review-a", kind: "standalone" },
          configPath: path.join(project, "paper-search.toml"),
          runsRoot: path.join(project, ".paper-search", "runs"),
        },
      });
      expect(await readFile(path.join(project, "paper-search.toml"), "utf8")).toContain('kind = "standalone"');

      const status = await runCli([
        "--config",
        path.join(project, "paper-search.toml"),
        "context",
        "status",
      ]);
      expect(status).toMatchObject({
        ok: true,
        tool: "context_status",
        data: {
          context: { id: "review-a", kind: "standalone" },
          runsRoot: path.join(project, ".paper-search", "runs"),
          configPath: path.join(project, "paper-search.toml"),
        },
      });

      const statusWithJson = await runCli([
        "--config",
        path.join(project, "paper-search.toml"),
        "context",
        "status",
        "--json",
      ]);
      expect(statusWithJson).toEqual(status);

      await expect(runCli(["context", "init", project])).resolves.toMatchObject({
        ok: false,
        tool: "context_init",
        errors: [expect.stringContaining("already exists")],
      });
    } finally {
      if (originalHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = originalHome;
    }
  });

  it("keeps rejecting unknown context status options", async () => {
    const program = buildProgram({
      stdout: { write(_chunk: string) {} },
      stderr: { write(_chunk: string) {} },
    });
    const statusCommand = program.commands
      .find((command) => command.name() === "context")
      ?.commands.find((command) => command.name() === "status");
    expect(statusCommand).toBeDefined();
    statusCommand!.exitOverride();

    await expect(program.parseAsync([
      "node",
      "paper-search",
      "context",
      "status",
      "--unknown-output-option",
    ])).rejects.toMatchObject({ code: "commander.unknownOption" });
  });
});
