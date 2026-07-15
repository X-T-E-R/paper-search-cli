import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";
import { loadConfig } from "../../src/config/load.js";
import { handleMcpToolCall } from "../../src/mcp/toolHandlers.js";
import { runCanonicalTool } from "../../src/surface/toolRunner.js";
import type { ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFixture(root: string, recordByDefault = true): Promise<{
  configPath: string;
  runsRoot: string;
}> {
  const installDir = path.join(root, "providers");
  const providerDir = path.join(installDir, "fixture-academic-searchable");
  const fixtureDir = path.resolve(
    "tests",
    "fixtures",
    "provider-packages",
    "fixture-academic-searchable",
  );
  await mkdir(providerDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(providerDir, "manifest.json"),
      await readFile(path.join(fixtureDir, "manifest.json"), "utf8"),
      "utf8",
    ),
    writeFile(
      path.join(providerDir, "provider.js"),
      await readFile(path.join(fixtureDir, "provider.js"), "utf8"),
      "utf8",
    ),
  ]);

  const runsRoot = path.join(root, "runs");
  const configPath = path.join(root, "paper-search.toml");
  await writeFile(configPath, [
    "schemaVersion = 1",
    "[providers]",
    `installDir = ${JSON.stringify(installDir)}`,
    "[runs]",
    `root = ${JSON.stringify(runsRoot)}`,
    "maxAgeDays = -1",
    `recordByDefault = ${recordByDefault}`,
    "",
  ].join("\n"), "utf8");
  return { configPath, runsRoot };
}

async function runCli(configPath: string, args: string[]): Promise<unknown> {
  let stdout = "";
  const program = buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(_chunk: string) {} },
  }).exitOverride();
  await program.parseAsync(["node", "paper-search", "--config", configPath, ...args]);
  return JSON.parse(stdout) as unknown;
}

async function runFiles(runsRoot: string): Promise<string[]> {
  try {
    return (await readdir(runsRoot)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("default-on discovery history", () => {
  it("records friendly CLI searches and honors --no-history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-history-cli-"));
    tempDirs.push(root);
    const fixture = await createFixture(root);

    const recorded = await runCli(fixture.configPath, ["academic", "history default"]);
    expect(recorded).toMatchObject({
      ok: true,
      tool: "academic_search",
      diagnostics: { historyRecorded: true, runId: expect.any(String) },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(1);

    const skipped = await runCli(fixture.configPath, [
      "academic",
      "history opt out",
      "--no-history",
    ]);
    expect(skipped).toMatchObject({
      ok: true,
      tool: "academic_search",
      diagnostics: { historyRecorded: false, historyOptOut: "request" },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(1);
  });

  it("shares config and per-call policy across canonical and MCP calls without double records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-history-canonical-"));
    tempDirs.push(root);
    const fixture = await createFixture(root, false);
    const config = await loadConfig({ explicitConfigPath: fixture.configPath, cwd: root });

    const configuredOff = await runCanonicalTool(config, "academic_search", {
      query: "configured off",
    });
    expect(configuredOff).toMatchObject({
      ok: true,
      diagnostics: { historyRecorded: false, historyOptOut: "config" },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(0);

    const forced = await runCanonicalTool(config, "academic_search", {
      query: "explicitly recorded",
      recordHistory: true,
    });
    expect(forced).toMatchObject({
      ok: true,
      diagnostics: { historyRecorded: true, runId: expect.any(String) },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(1);

    const legacyAlias = await handleMcpToolCall(config, "resource_search", {
      query: "legacy alias explicitly recorded",
      recordHistory: true,
    }) as ResultEnvelope;
    expect(legacyAlias).toMatchObject({
      ok: true,
      tool: "academic_search",
      diagnostics: { historyRecorded: true, runId: expect.any(String) },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(2);

    const mcpSkipped = await handleMcpToolCall(config, "academic_search", {
      query: "mcp opt out",
      recordHistory: false,
    }) as ResultEnvelope;
    expect(mcpSkipped).toMatchObject({
      ok: true,
      diagnostics: { historyRecorded: false, historyOptOut: "request" },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(2);

    const explicitRun = await runCanonicalTool(config, "research_run", {
      tool: "academic_search",
      arguments: { query: "explicit durable wrapper" },
    });
    expect(explicitRun).toMatchObject({
      ok: true,
      tool: "research_run",
      diagnostics: { historyRecorded: true, runId: expect.any(String) },
    });
    expect(await runFiles(fixture.runsRoot)).toHaveLength(3);
  });

  it("records batch discovery rows unless the batch explicitly opts out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-history-batch-"));
    tempDirs.push(root);
    const fixture = await createFixture(root);
    const firstBatch = path.join(root, "recorded.json");
    const secondBatch = path.join(root, "skipped.json");
    await writeFile(firstBatch, JSON.stringify([{ tool: "academic_search", query: "batch recorded" }]), "utf8");
    await writeFile(secondBatch, JSON.stringify([{ tool: "academic_search", query: "batch skipped" }]), "utf8");

    const recorded = await runCli(fixture.configPath, [
      "batch",
      firstBatch,
      "--output-format",
      "json",
    ]);
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "ok",
        diagnostics: expect.objectContaining({ historyRecorded: true, runId: expect.any(String) }),
      }),
    ]));
    expect(await runFiles(fixture.runsRoot)).toHaveLength(1);

    const skipped = await runCli(fixture.configPath, [
      "batch",
      secondBatch,
      "--output-format",
      "json",
      "--no-history",
    ]);
    expect(skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "ok",
        diagnostics: expect.objectContaining({ historyRecorded: false, historyOptOut: "request" }),
      }),
    ]));
    expect(await runFiles(fixture.runsRoot)).toHaveLength(1);
  });

  it("validates MCP arguments consistently and rejects planned wrappers before creating run storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-history-validation-"));
    tempDirs.push(root);
    const fixture = await createFixture(root, false);
    const config = await loadConfig({ explicitConfigPath: fixture.configPath, cwd: root });

    for (const recordHistory of [false, true]) {
      const invalid = await handleMcpToolCall(config, "academic_search", {
        query: "invalid MCP input",
        recordHistory,
        unexpected: true,
      }) as ResultEnvelope;
      expect(invalid).toMatchObject({
        ok: false,
        tool: "academic_search",
        diagnostics: { reason: "invalid_arguments" },
      });
    }

    const planned = await runCanonicalTool(config, "research_run", {
      tool: "academic_search",
      arguments: { query: "no write", dryRun: true },
    });
    expect(planned).toMatchObject({
      ok: false,
      tool: "research_run",
      diagnostics: {
        reason: "planned_operation_not_persisted",
        wrappedTool: "academic_search",
      },
    });
    await expect(access(fixture.runsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
