import { Command } from "commander";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerRunsCommand } from "../../src/commands/runs.js";
import { createIo } from "../../src/runtime/io.js";
import { openResearchRunStore, type ResearchRunStore } from "../../src/runs/index.js";
import type { ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function fixture(): Promise<{
  root: string;
  configPath: string;
  store: ResearchRunStore;
  runId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-runs-command-"));
  tempDirs.push(root);
  const configPath = path.join(root, "paper-search.toml");
  await writeFile(configPath, "", "utf8");
  const store = await openResearchRunStore({ root: path.join(root, "runs"), maxAgeDays: -1 });
  const created = await store.create({
    kind: "tool",
    request: { tool: "resource_lookup", args: { identifier: "10.1/example" } },
    build: { cliVersion: "1.0.0" },
  });
  await store.finish(created.runId, { status: "failed", result: { ok: false } });
  return { root, configPath, store, runId: created.runId };
}

async function runManagementCommand(
  configPath: string,
  store: ResearchRunStore,
  args: string[],
): Promise<ResultEnvelope> {
  let stdout = "";
  let stderr = "";
  const program = new Command()
    .name("paper-search")
    .option("--config <path>");
  const io = createIo({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write(chunk: string) { stderr += chunk; } },
  });
  registerRunsCommand(program, io, { resolveStore: async () => store });
  await program.exitOverride().parseAsync([
    "node",
    "paper-search",
    "--config",
    configPath,
    "runs",
    ...args,
  ]);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as ResultEnvelope;
}

describe("runs management commands", () => {
  it("lists and shows common run records", async () => {
    const { configPath, store, runId } = await fixture();

    await expect(runManagementCommand(configPath, store, ["list", "--status", "failed"]))
      .resolves.toMatchObject({
        ok: true,
        tool: "run_list",
        data: { count: 1, runs: [{ runId, status: "failed" }] },
      });
    await expect(runManagementCommand(configPath, store, ["show", runId]))
      .resolves.toMatchObject({
        ok: true,
        tool: "run_show",
        data: { run: { runId, status: "failed", finishedAt: expect.any(String) } },
      });
  });

  it("pins, unpins, and exports without overwriting an explicit path", async () => {
    const { root, configPath, store, runId } = await fixture();
    await expect(runManagementCommand(configPath, store, ["pin", runId]))
      .resolves.toMatchObject({ ok: true, tool: "run_pin", data: { runId, pinned: true } });
    await expect(runManagementCommand(configPath, store, ["unpin", runId]))
      .resolves.toMatchObject({ ok: true, tool: "run_unpin", data: { runId, pinned: false } });

    const output = path.join(root, "exports", "run.json");
    await expect(runManagementCommand(configPath, store, ["export", runId, "--out", output]))
      .resolves.toMatchObject({ ok: true, tool: "run_export", data: { runId, path: output } });
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ runId });
    await expect(runManagementCommand(configPath, store, ["export", runId, "--out", output]))
      .resolves.toMatchObject({
        ok: false,
        tool: "run_export",
        diagnostics: { reason: "run_export_exists" },
      });
  });

  it("keeps prune plan-first and honors the configured -1 policy", async () => {
    const { configPath, store, runId } = await fixture();
    await expect(runManagementCommand(configPath, store, ["prune"]))
      .resolves.toMatchObject({
        ok: true,
        tool: "run_prune_plan",
        planned: true,
        data: {
          planned: true,
          maxAgeDays: -1,
          candidates: [],
          exclusions: [expect.objectContaining({ runId, reason: "retention-disabled" })],
        },
      });
    await expect(store.read(runId)).resolves.toMatchObject({ runId });
  });
});
