import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBatchTask,
  executeBatchTask,
  type BatchDefaults,
} from "../../src/batch/core.js";
import { createDefaultConfig } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function defaults(): BatchDefaults {
  return {
    addMode: "first",
    collectionMap: {},
    extraTags: [],
    fetchPdf: false,
    includeRaw: false,
    skipStatuses: new Set(),
  };
}

function configFor(root: string): ResolvedConfig {
  const base = createDefaultConfig({
    HOME: root,
    USERPROFILE: root,
    PAPER_SEARCH_HOME: path.join(root, ".paper-search"),
  });
  return {
    ...base,
    meta: {
      cwd: root,
      userConfigPath: path.join(root, ".paper-search", "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
}

describe("Paper Search CLI X batch workflow rows", () => {
  it("projects citation convenience columns onto the canonical schema and disables add mode", () => {
    const task = buildBatchTask(
      {
        id: "citation-plan",
        tool: "citation",
        mode: "plan",
        doi: "10.1000/a;10.1000/b",
        direction: "backward,forward",
        provider: "semantic",
        depth: "0",
      },
      0,
      defaults(),
    );

    expect(task).toMatchObject({
      tool: "citation_expand",
      addMode: "none",
      args: {
        mode: "plan",
        seeds: [
          { identifiers: { doi: "10.1000/a" } },
          { identifiers: { doi: "10.1000/b" } },
        ],
        directions: ["backward", "forward"],
        providers: ["semantic"],
        limits: { depth: 0 },
      },
    });
  });

  it("accepts exact canonical assessment args without enabling workspace adds", () => {
    const task = buildBatchTask(
      {
        tool: "assessment",
        args_json: JSON.stringify({
          mode: "run",
          snapshotPath: "C:/snapshots/paper.json",
          snapshotSha256: "a".repeat(64),
        }),
      },
      0,
      defaults(),
    );

    expect(task).toMatchObject({
      tool: "assessment_run",
      addMode: "none",
      args: {
        mode: "run",
        snapshotPath: "C:/snapshots/paper.json",
        snapshotSha256: "a".repeat(64),
      },
    });
  });

  it("executes a citation plan through the canonical runner without creating the run root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-batch-x-"));
    tempDirs.push(root);
    const config = configFor(root);
    const task = buildBatchTask(
      {
        tool: "citation_expand",
        mode: "plan",
        doi: "10.1000/plan-only",
        depth: "0",
      },
      0,
      defaults(),
    );

    const result = await executeBatchTask({ config }, task, false);

    expect(result).toMatchObject({
      status: "ok",
      ok: true,
      capability: "orchestrate",
      tool: "citation_expand",
      planned: true,
      data: { mode: "plan" },
    });
    await expect(access(config.runs.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
