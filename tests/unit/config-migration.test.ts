import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "@iarna/toml";
import { parseLegacyV0Config } from "../../src/config/legacyV0.js";
import { executeConfigMigration, planConfigMigration } from "../../src/config/migration.js";
import { resolveConfigBundlePaths } from "../../src/config/paths.js";
import { applyCredentialPermissions } from "../../src/config/permissions.js";
import { applyConfigTransaction } from "../../src/config/transactions.js";
import { digestConfigContent, readUserConfigFile } from "../../src/config/userConfig.js";
import { readIdentity, readSubscriptionsFile } from "../../src/subscriptions/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function createRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
  return { root, env, bundle: resolveConfigBundlePaths(env) };
}

describe("legacy v0 configuration migration", () => {
  it("uses a tolerant dedicated parser but blocks unknown and ambiguous keys", () => {
    const result = parseLegacyV0Config(parse([
      "[defaults]",
      "maxResults = 25",
      "unknown = true",
      "",
      "[api.example]",
      'customValue = "cannot-classify"',
      "",
    ].join("\n")));
    expect(result.recognized).toEqual({ defaults: { maxResults: 25 } });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "defaults.unknown", reason: "unknown-key" }),
      expect.objectContaining({ key: "api.example.customValue", reason: "ambiguous-secret" }),
    ]));
  });

  it("plans, applies, and reruns an idempotent split-file migration without exposing secrets", async () => {
    const { root, env, bundle } = await createRoot("paper-search-config-migrate-");
    const project = path.join(root, "project");
    const legacyProviders = path.join(root, "legacy-providers");
    await mkdir(path.dirname(bundle.config), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "paper-search.toml"), "[output]\nlocale = \"en-US\"\n");
    await writeFile(path.join(project, ".paper-search.toml"), "[defaults]\nmaxResults = 2\n");
    const secret = "migration-secret-value";
    await writeFile(bundle.config, [
      "[providers]",
      'registryUrl = "https://example.test/registry.json"',
      `installDir = "${legacyProviders.replace(/\\/g, "\\\\")}"`,
      "autoUpdate = false",
      "allowReleaseFallback = true",
      "",
      "[defaults]",
      "maxResults = 55",
      "",
      "[api.openai]",
      `apiKey = "${secret}"`,
      "",
    ].join("\n"));

    await expect(readUserConfigFile(bundle.config)).rejects.toThrow(/requires `paper-search migrate`/);
    const plan = await planConfigMigration({ cwd: project, env });
    expect(plan.blockers).toEqual([]);
    expect(plan.duplicateProjectConfigs).toBe(true);
    expect(plan.subscriptionProposal).toEqual({
      id: "legacy-search",
      runtimeKind: "search",
      url: "https://example.test/registry.json",
    });
    expect(plan.legacyInstallDirectory).toMatchObject({
      source: legacyProviders,
      origin: "legacy-user-config",
      requiresExplicitSelection: true,
      selectedForProviderMigration: false,
      operationalOwnership: "machine-data-root",
      action: "report-only",
    });
    expect(JSON.stringify(plan)).not.toContain(secret);

    const applied = await executeConfigMigration({ cwd: project, env, apply: true });
    expect(applied.applied).toBe(true);
    expect(await readFile(bundle.config, "utf8")).toContain("schemaVersion = 1");
    expect(await readFile(bundle.config, "utf8")).not.toContain(secret);
    expect(await readFile(bundle.credentials, "utf8")).toContain(secret);
    if (process.platform !== "win32") {
      expect((await stat(bundle.credentials)).mode & 0o777).toBe(0o600);
    }
    expect((await readSubscriptionsFile(env)).subscriptions["legacy-search"]).toMatchObject({
      runtimeKind: "search",
      url: "https://example.test/registry.json",
    });
    expect(await readIdentity("legacy-search", env)).toMatchObject({
      subscriptionId: "legacy-search",
      runtimeKind: "search",
    });
    const rerun = await executeConfigMigration({ cwd: project, env, apply: true });
    expect(rerun.applied).toBe(true);
    expect(rerun.plan.alreadyMigrated).toBe(true);
    expect(await readFile(path.join(project, "paper-search.toml"), "utf8")).toContain("en-US");
    expect(await readFile(path.join(project, ".paper-search.toml"), "utf8")).toContain("maxResults");
  });

  it("recovers a journaled two-file transaction after an interruption", async () => {
    const { root, env } = await createRoot("paper-search-config-recovery-");
    const first = path.join(root, "files", "config.toml");
    const second = path.join(root, "files", "credentials.toml");
    const changes = [
      { path: first, expectedDigest: digestConfigContent(""), content: "schemaVersion = 1\n" },
      { path: second, expectedDigest: digestConfigContent(""), content: "schemaVersion = 1\n", mode: 0o600 },
    ];
    let interrupted = false;
    await expect(applyConfigTransaction({
      command: "test recovery",
      planDigest: "a".repeat(64),
      changes,
      env,
      onChangeApplied(filePath) {
        if (!interrupted && filePath === first) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    })).rejects.toThrow("simulated interruption");

    const recovered = await applyConfigTransaction({
      command: "test recovery",
      planDigest: "a".repeat(64),
      changes,
      env,
    });
    expect(recovered.recovered).toHaveLength(1);
    expect(await readFile(first, "utf8")).toBe("schemaVersion = 1\n");
    expect(await readFile(second, "utf8")).toBe("schemaVersion = 1\n");
  });

  it("reports project/environment install-directory origins without moving them", async () => {
    const { root, env, bundle } = await createRoot("paper-search-config-origin-");
    const project = path.join(root, "project");
    await mkdir(path.dirname(bundle.config), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(bundle.config, "[defaults]\nmaxResults = 5\n");
    await writeFile(path.join(project, "paper-search.toml"), "[providers]\ninstallDir = \"./project-providers\"\n");
    env.PAPER_SEARCH_PROVIDERS_INSTALL_DIR = "./environment-providers";
    const plan = await planConfigMigration({ cwd: project, env });
    expect(plan.legacyInstallDirectory).toMatchObject({
      source: path.join(project, "environment-providers"),
      origin: "environment-requires-explicit",
      requiresExplicitSelection: true,
      action: "report-only",
    });
    await expect(stat(path.join(project, "environment-providers"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("constructs and verifies Windows ACL commands through an injected runner", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const report = await applyCredentialPermissions("C:\\temp\\credentials.toml", {
      platform: "win32",
      async run(executable, args) {
        calls.push({ executable, args });
        if (executable === "whoami.exe") return { stdout: '"user","S-1-5-21-42"', stderr: "" };
        return { stdout: "credentials.toml USER:(F)", stderr: "" };
      },
    });
    expect(report).toMatchObject({ restricted: true, verified: true });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ executable: "icacls.exe", args: expect.arrayContaining(["/inheritance:r"]) }),
      expect.objectContaining({ executable: "icacls.exe", args: expect.arrayContaining(["*S-1-5-21-42:(F)"]) }),
    ]));
  });
});
