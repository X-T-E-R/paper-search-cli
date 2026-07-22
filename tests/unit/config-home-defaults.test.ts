import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { RunsConfigSchema } from "../../src/config/schema.js";

const saved: Record<string, string | undefined> = {};
const names = [
  "PAPER_SEARCH_HOME",
  "PAPER_SEARCH_STORAGE_ARTIFACT_ROOT",
  "PAPER_SEARCH_RUNS_MAX_AGE_DAYS",
  "PAPER_SEARCH_RUNS_RECORD_BY_DEFAULT",
] as const;
for (const name of names) saved[name] = process.env[name];

afterEach(() => {
  for (const name of names) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("unified-home config defaults", () => {
  it("keeps implicit defaults identical across unrelated working directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-home-defaults-"));
    const home = path.join(root, "authority");
    const cwdA = path.join(root, "a");
    const cwdB = path.join(root, "b");
    await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
    process.env.PAPER_SEARCH_HOME = home;

    const [a, b] = await Promise.all([loadConfig({ cwd: cwdA }), loadConfig({ cwd: cwdB })]);
    expect({
      providers: a.providers.installDir,
      workspace: a.workspace.root,
      storage: a.storage,
      runs: a.runs.root,
    }).toEqual({
      providers: b.providers.installDir,
      workspace: b.workspace.root,
      storage: b.storage,
      runs: b.runs.root,
    });
    for (const configured of [
      a.providers.installDir,
      a.workspace.root,
      ...Object.values(a.storage),
      a.runs.root,
    ]) {
      expect(path.relative(home, configured)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    }
  });

  it("preserves config-origin and CWD-relative environment path semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-home-origins-"));
    const home = path.join(root, "authority");
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "paper-search.toml"), [
      "schemaVersion = 1",
      "[storage]",
      'extractionRoot = "./project-extractions"',
      'exportRoot = "./project-exports"',
      "[runs]",
      'root = "./project-runs"',
      "maxAgeDays = 30",
      "",
    ].join("\n"));
    process.env.PAPER_SEARCH_HOME = home;
    process.env.PAPER_SEARCH_STORAGE_ARTIFACT_ROOT = "./env-artifacts";
    process.env.PAPER_SEARCH_RUNS_MAX_AGE_DAYS = "7";
    process.env.PAPER_SEARCH_RUNS_RECORD_BY_DEFAULT = "false";

    const config = await loadConfig({ cwd: project });
    expect(config.storage).toEqual({
      artifactRoot: path.join(project, "env-artifacts"),
      extractionRoot: path.join(project, "project-extractions"),
      exportRoot: path.join(project, "project-exports"),
    });
    expect(config.runs).toEqual({
      root: path.join(project, "project-runs"),
      maxAgeDays: 7,
      recordByDefault: false,
    });
    expect(config.zotero).toMatchObject({ enabled: false, unavailable: "error" });
  });

  it("accepts -1 or positive integer retention and rejects zero, fractions, and lower negatives", () => {
    expect(RunsConfigSchema.parse({ root: "/runs", maxAgeDays: -1, recordByDefault: true }).maxAgeDays).toBe(-1);
    expect(RunsConfigSchema.parse({ root: "/runs", maxAgeDays: 1, recordByDefault: false }).maxAgeDays).toBe(1);
    for (const maxAgeDays of [0, 1.5, -2]) {
      expect(() => RunsConfigSchema.parse({ root: "/runs", maxAgeDays, recordByDefault: true })).toThrow();
    }
    expect(() => RunsConfigSchema.parse({ root: "/runs", maxAgeDays: -1 })).toThrow();
  });

  it("rejects project authority that attempts to configure Zotero host writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-authority-"));
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "paper-search.toml"), "schemaVersion = 1\n[zotero]\nenabled = true\n");
    process.env.PAPER_SEARCH_HOME = path.join(root, "authority");
    await expect(loadConfig({ cwd: project })).rejects.toThrow(/forbidden_config_authority.*Zotero/u);

    await writeFile(
      path.join(project, "paper-search.toml"),
      'schemaVersion = 1\n[zotero]\nendpoint = "http://127.0.0.1:29999/mcp"\n',
    );
    await expect(loadConfig({ cwd: project })).rejects.toThrow(/forbidden_config_authority.*Zotero/u);
  });

  it("allows project Zotero binding policy without granting endpoint authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-zotero-binding-"));
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(
      path.join(project, "paper-search.toml"),
      [
        "schemaVersion = 1",
        "[zoteroBinding]",
        'mode = "bound"',
        'collectionKeys = ["PROJECT1", "SHARED2"]',
        'attachmentMode = "link"',
        "",
      ].join("\n"),
    );
    process.env.PAPER_SEARCH_HOME = path.join(root, "authority");
    const config = await loadConfig({ cwd: project });
    expect(config.zotero.enabled).toBe(false);
    expect(config.zoteroBinding).toEqual({
      mode: "bound",
      collectionKeys: ["PROJECT1", "SHARED2"],
      attachmentMode: "link",
    });
  });
});
