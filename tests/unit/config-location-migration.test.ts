import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConfigLocationMigration,
  planConfigLocationMigration,
} from "../../src/config/locationMigration.js";
import { loadConfig } from "../../src/config/load.js";

const previous = {
  home: process.env.PAPER_SEARCH_HOME,
  mode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
  data: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
  appData: process.env.APPDATA,
  xdg: process.env.XDG_CONFIG_HOME,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("PAPER_SEARCH_HOME", previous.home);
  restore("PAPER_SEARCH_INSTALL_TEST_MODE", previous.mode);
  restore("PAPER_SEARCH_TEST_DATA_ROOT", previous.data);
  restore("APPDATA", previous.appData);
  restore("XDG_CONFIG_HOME", previous.xdg);
});

function env(root: string): NodeJS.ProcessEnv {
  return {
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
  };
}

async function writeLegacy(root: string, content = "schemaVersion = 1\n[defaults]\nmaxResults = 17\n"): Promise<string> {
  const legacy = path.join(root, "appdata", "paper-search");
  await mkdir(path.join(legacy, "config.d"), { recursive: true });
  await writeFile(path.join(legacy, "config.toml"), content, "utf8");
  await writeFile(path.join(legacy, "credentials.toml"), "schemaVersion = 1\n", "utf8");
  await writeFile(path.join(legacy, "config.d", "20-output.toml"), "[output]\nlocale = \"en-US\"\n", "utf8");
  return legacy;
}

describe("legacy config-location migration", () => {
  it("plans without writes, copies known files, preserves the source, receipts, and reruns idempotently", async () => {
    const actualRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-location-"));
    const testEnv = env(actualRoot);
    const legacy = await writeLegacy(actualRoot);

    const plan = await planConfigLocationMigration({ env: testEnv, userHome: path.join(actualRoot, "user") });
    expect(plan).toMatchObject({ status: "pending", selectedSource: legacy, destinationBundlePresent: false });
    await expect(access(path.join(actualRoot, "home", "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await applyConfigLocationMigration({ env: testEnv, userHome: path.join(actualRoot, "user") });
    expect(applied).toMatchObject({ applied: true, changed: true });
    expect(await readFile(path.join(actualRoot, "home", "config.toml"), "utf8")).toContain("maxResults = 17");
    expect(await readFile(path.join(legacy, "config.toml"), "utf8")).toContain("maxResults = 17");
    expect(JSON.parse(await readFile(path.join(actualRoot, "home", "state", "migrations", "config-location-v1.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      status: "complete",
      sourceRoot: legacy,
    });

    const rerun = await applyConfigLocationMigration({ env: testEnv, userHome: path.join(actualRoot, "user") });
    expect(rerun).toMatchObject({ applied: true, changed: false });

    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(actualRoot, "home");
    process.env.APPDATA = path.join(actualRoot, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(actualRoot, "xdg");
    await rm(legacy, { recursive: true });
    await writeFile(legacy, "normal config loading must not inspect this legacy path", "utf8");

    const loaded = await loadConfig({ cwd: actualRoot });
    expect(loaded.defaults.maxResults).toBe(17);
  });

  it("requires an explicit source when different non-empty legacy roots coexist", async () => {
    const root = path.join(os.tmpdir(), `paper-search-location-ambiguous-${process.pid}-${Date.now()}`);
    const testEnv = env(root);
    const appDataRoot = await writeLegacy(root);
    const xdgRoot = path.join(root, "xdg", "paper-search");
    await mkdir(xdgRoot, { recursive: true });
    await writeFile(path.join(xdgRoot, "config.toml"), "schemaVersion = 1\n[defaults]\nmaxResults = 99\n", "utf8");

    const plan = await planConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user") });
    expect(plan).toMatchObject({ status: "ambiguous", requiresExplicitSource: true, selectedSource: null });
    const selected = await planConfigLocationMigration({
      env: testEnv,
      userHome: path.join(root, "user"),
      legacyConfigRoot: appDataRoot,
    });
    expect(selected).toMatchObject({ status: "pending", requiresExplicitSource: false, selectedSource: appDataRoot });
  });

  it("recovers an interrupted copy-only migration without treating its first destination entry as authoritative", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-location-recovery-"));
    const testEnv = env(root);
    const legacy = await writeLegacy(root);
    let copied = 0;

    await expect(applyConfigLocationMigration({
      env: testEnv,
      userHome: path.join(root, "user"),
      onChangeApplied: () => {
        copied += 1;
        if (copied === 1) throw new Error("Injected location migration interruption");
      },
    })).rejects.toThrow("Injected location migration interruption");

    const interrupted = await planConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user") });
    expect(interrupted).toMatchObject({ status: "pending", selectedSource: legacy, receiptPresent: false });
    expect(interrupted.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "identical" }),
      expect.objectContaining({ action: "copy" }),
    ]));

    const recovered = await applyConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user") });
    expect(recovered).toMatchObject({ applied: true, changed: true, receiptPath: expect.any(String) });
    for (const relativePath of ["config.toml", "credentials.toml", "config.d/20-output.toml"]) {
      expect(await readFile(path.join(root, "home", ...relativePath.split("/")), "utf8"))
        .toBe(await readFile(path.join(legacy, ...relativePath.split("/")), "utf8"));
    }
    expect(JSON.parse(await readFile(path.join(root, "home", "state", "migrations", "config-location-v1.json"), "utf8")))
      .toMatchObject({ schemaVersion: 1, status: "complete", sourceRoot: legacy });
  });

  it("fails closed on explicit destination conflicts and never reads the legacy root live", async () => {
    const root = path.join(os.tmpdir(), `paper-search-location-conflict-${process.pid}-${Date.now()}`);
    const testEnv = env(root);
    const legacy = await writeLegacy(root);
    await mkdir(path.join(root, "home"), { recursive: true });
    await writeFile(path.join(root, "home", "config.toml"), "schemaVersion = 1\n[defaults]\nmaxResults = 3\n", "utf8");

    const ignored = await planConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user") });
    expect(ignored.status).toBe("conflicted");
    const conflict = await planConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user"), legacyConfigRoot: legacy });
    expect(conflict).toMatchObject({ status: "conflicted" });
    expect((await applyConfigLocationMigration({ env: testEnv, userHome: path.join(root, "user"), legacyConfigRoot: legacy })).applied).toBe(false);

    process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
    process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "fresh-home");
    process.env.APPDATA = path.join(root, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(root, "empty-xdg");
    await expect(loadConfig()).rejects.toMatchObject({ code: "config_location_migration_required" });
  });
});
