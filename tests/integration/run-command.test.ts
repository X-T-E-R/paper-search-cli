import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      "[runs]",
      `root = ${JSON.stringify(path.join(root, "runs"))}`,
      "maxAgeDays = -1",
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
  it("rejects management tools outside the durable discovery allowlist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-json-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "mcp_help",
      "--json-args",
      '{"topic":"overview","locale":"en"}',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      capability: "operate",
      tool: "mcp_help",
      data: null,
      diagnostics: { reason: "durable_tool_not_allowed" },
    });
  });

  it("parses repeated --arg pairs before applying the fixed allowlist", async () => {
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
      ok: false,
      capability: "operate",
      tool: "mcp_help",
      data: null,
      diagnostics: { reason: "durable_tool_not_allowed" },
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
    await expect(access(path.join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects plan/dry-run wrapper requests without creating the run root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-plan-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "academic_search",
      "--json-args",
      '{"query":"no persistence","dryRun":true}',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      diagnostics: { reason: "planned_operation_not_persisted" },
    });
    await expect(access(path.join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a failed allowlisted discovery execution as a terminal durable run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-run-failed-"));
    tempDirs.push(root);

    const envelope = await runCommand(root, [
      "academic_search",
      "--json-args",
      '{"query":"durable graph search","sources":["not-installed"]}',
    ]);

    expect(envelope).toMatchObject({
      ok: false,
      tool: "academic_search",
      diagnostics: {
        runId: expect.any(String),
        runPath: expect.any(String),
      },
    });
    const runId = String(envelope.diagnostics?.runId);
    const raw = JSON.parse(await readFile(path.join(root, "runs", `${runId}.json`), "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      runId,
      kind: "tool",
      status: "failed",
      finishedAt: expect.any(String),
      request: {
        tool: "academic_search",
        args: { query: "durable graph search", sources: ["not-installed"] },
      },
      resolvedSelection: {
        requested: { sources: ["not-installed"] },
      },
    });
  });
});
