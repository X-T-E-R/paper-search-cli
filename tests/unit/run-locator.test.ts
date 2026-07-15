import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  openRunStoreFromResolvedConfig,
  readRunFromConfiguredOrLocatedStore,
} from "../../src/runs/config.js";
import { readRunLocator, registerRunLocator } from "../../src/runs/locator.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function configFor(
  home: string,
  context: ResolvedConfig["context"],
  runsRoot: string,
): { config: ResolvedConfig; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, PAPER_SEARCH_HOME: home };
  return {
    env,
    config: {
      ...createDefaultConfig(env),
      context,
      runs: { root: runsRoot, maxAgeDays: -1, recordByDefault: true },
      meta: {
        cwd: home,
        userConfigPath: path.join(home, "config.toml"),
        projectConfigPath: null,
        explicitConfigPath: null,
        loadedFiles: [],
        appliedEnvOverrides: [],
      },
    },
  };
}

async function createRun(config: ResolvedConfig, env: NodeJS.ProcessEnv, runId?: string) {
  const store = await openRunStoreFromResolvedConfig(config, env);
  return store.create({
    ...(runId ? { runId } : {}),
    kind: "tool",
    request: { tool: "academic_search", args: { query: "locator" } },
    build: { cliVersion: "test" },
  });
}

describe("run locators", () => {
  it("does not create a locator for the global run root", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paper-search-locator-global-"));
    tempDirs.push(home);
    const { config, env } = configFor(home, { id: "global", kind: "global" }, path.join(home, "runs"));
    const run = await createRun(config, env);
    await expect(readRunLocator(run.runId, env)).resolves.toBeNull();
  });

  it("stores a context run once and follows its private global locator", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paper-search-locator-context-"));
    tempDirs.push(home);
    const contextRoot = path.join(home, "project", "runs");
    const context = configFor(home, { id: "project-a", kind: "standalone" }, contextRoot);
    const run = await createRun(context.config, context.env);

    await expect(readRunLocator(run.runId, context.env)).resolves.toMatchObject({
      runId: run.runId,
      contextId: "project-a",
      contextKind: "standalone",
      runRoot: contextRoot,
    });
    await expect(access(path.join(home, "runs", `${run.runId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const global = configFor(home, { id: "global", kind: "global" }, path.join(home, "runs"));
    await expect(readRunFromConfiguredOrLocatedStore(
      global.config,
      run.runId,
      undefined,
      global.env,
    )).resolves.toMatchObject({
      located: true,
      root: contextRoot,
      record: { runId: run.runId },
    });
  });

  it("rejects conflicting and stale locators without leaving a new run payload", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paper-search-locator-conflict-"));
    tempDirs.push(home);
    const runId = "20260715T000000.000Z-00000000-0000-4000-8000-000000000000";
    const first = configFor(home, { id: "first", kind: "standalone" }, path.join(home, "first", "runs"));
    const second = configFor(home, { id: "second", kind: "standalone" }, path.join(home, "second", "runs"));
    await registerRunLocator(first.config, runId, first.config.runs.root, first.env);

    await expect(createRun(second.config, second.env, runId))
      .rejects.toThrow(/another context/u);
    await expect(access(path.join(second.config.runs.root, `${runId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const global = configFor(home, { id: "global", kind: "global" }, path.join(home, "runs"));
    await expect(readRunFromConfiguredOrLocatedStore(
      global.config,
      runId,
      undefined,
      global.env,
    )).rejects.toThrow(/stale/u);
  });
});
