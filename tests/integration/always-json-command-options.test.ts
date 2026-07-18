import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

const alwaysEnvelopeCommandPaths = [
  ["assess", "plan"],
  ["assess", "run"],
  ["assess", "show"],
  ["assess", "list"],
  ["artifact", "download"],
  ["artifact", "list"],
  ["artifact", "show"],
  ["citation", "plan"],
  ["citation", "run"],
  ["citation", "resume"],
  ["citation", "status"],
  ["config", "path"],
  ["config", "validate"],
  ["config", "explain"],
  ["config", "keys"],
  ["config", "list"],
  ["config", "get"],
  ["config", "set"],
  ["config", "unset"],
  ["config", "credentials", "set"],
  ["config", "credentials", "get"],
  ["config", "credentials", "unset"],
  ["config", "import-env"],
  ["context", "status"],
  ["context", "init"],
  ["extract"],
  ["lookup"],
  ["material", "ingest"],
  ["material", "status"],
  ["migrate"],
  ["resource-pdf"],
  ["registries", "list"],
  ["registries", "show"],
  ["registries", "add"],
  ["registries", "rebind"],
  ["registries", "enable"],
  ["registries", "disable"],
  ["registries", "remove"],
  ["registries", "refresh"],
  ["run"],
  ["runs", "list"],
  ["runs", "show"],
  ["runs", "export"],
  ["runs", "pin"],
  ["runs", "unpin"],
  ["runs", "prune"],
  ["academic"],
  ["patent"],
  ["search-plan"],
  ["patent-detail"],
  ["web"],
  ["zotero", "status"],
  ["zotero", "sync"],
  ["zotero", "sink"],
] as const;
const alwaysEnvelopeCommandCases = alwaysEnvelopeCommandPaths.map((commandPath) => ({
  commandPath,
  label: commandPath.join(" "),
}));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function commandAt(program: Command, commandPath: readonly string[]): Command {
  let current = program;
  for (const name of commandPath) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) throw new Error(`Command not registered: ${commandPath.join(" ")}`);
    current = next;
  }
  return current;
}

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  let stdout = "";
  await buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(_chunk: string) {} },
  }).parseAsync(["node", "paper-search", ...args]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("always-JSON command compatibility", () => {
  it.each(alwaysEnvelopeCommandCases)("registers command-local --json for $label", ({ commandPath }) => {
    const command = commandAt(buildProgram(), commandPath);
    expect(command.options.some((option) => option.long === "--json")).toBe(true);
  });

  it("keeps citation plan output identical with the compatibility flag", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-always-json-"));
    tempDirs.push(root);
    const originalHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = path.join(root, "home");
    try {
      const args = ["citation", "plan", "--doi", "10.1000/compatibility-test", "--depth", "1"];
      const withoutFlag = await runCli(args);
      const withFlag = await runCli([...args, "--json"]);
      expect(withFlag).toEqual(withoutFlag);
      expect(withFlag).toMatchObject({
        capability: "orchestrate",
        tool: "citation_expand",
      });
    } finally {
      if (originalHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = originalHome;
    }
  });

  it("still rejects unknown citation plan options", async () => {
    const program = buildProgram();
    commandAt(program, ["citation", "plan"]).exitOverride();
    await expect(program.parseAsync([
      "node",
      "paper-search",
      "citation",
      "plan",
      "--unknown-output-option",
    ])).rejects.toMatchObject({ code: "commander.unknownOption" });
  });

  it("does not widen --json to raw catalog or multi-format commands", async () => {
    for (const commandPath of [["help"], ["batch"]] as const) {
      const program = buildProgram();
      commandAt(program, commandPath).exitOverride();
      await expect(program.parseAsync([
        "node",
        "paper-search",
        ...commandPath,
        "--json",
      ])).rejects.toMatchObject({ code: "commander.unknownOption" });
    }
  });
});
