import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createConfig(root: string): Promise<string> {
  const configPath = path.join(root, "paper-search.toml");
  await writeFile(
    configPath,
    [
      "[providers]",
      `installDir = ${JSON.stringify(path.join(root, "providers"))}`,
      "",
      "[workspace]",
      `root = ${JSON.stringify(path.join(root, "workspace"))}`,
      'defaultCollection = "Inbox"',
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function runCommand(root: string, args: string[]): Promise<ResultEnvelope> {
  const configPath = await createConfig(root);
  let stdout = "";
  let stderr = "";
  const program = buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(chunk: string) { stderr += chunk; } },
  }).exitOverride();

  await program.parseAsync(["node", "paper-search", "--config", configPath, "run", ...args]);
  expect(stderr).toBe("");
  const parsed = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(parsed)).toBe(true);
  return parsed;
}

describe("run command", () => {
  it("invokes a canonical tool with --json-args and returns its envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-json-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "mcp_help",
      "--json-args",
      '{"topic":"overview","locale":"en"}',
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "mcp_help",
      data: {
        surface: "capability-first",
        locale: "en",
      },
    });
  });

  it("invokes a canonical tool with repeated --arg key=value pairs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-arg-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "mcp_help",
      "--arg",
      "topic=tools",
      "--arg",
      "locale=en",
    ]);

    expect(envelope).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "mcp_help",
      data: {
        surface: "capability-first",
        locale: "en",
      },
    });
  });

  it("rejects invalid arguments before invoking a canonical tool", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-invalid-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "web_search",
      "--json-args",
      '{"query":"RAG evaluation","mode":"not-a-mode"}',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      capability: "discover",
      tool: "web_search",
      data: null,
      diagnostics: { reason: "invalid_arguments" },
      errors: [expect.stringContaining("mode must be one of")],
    });
  });
});
