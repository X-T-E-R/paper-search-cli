import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

describe("status command", () => {
  it("reports the default smoke gate as env-required rather than config-disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-status-default-"));
    tempDirs.push(root);

    let stdout = "";
    const originalCwd = process.cwd();
    process.chdir(root);

    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "status", "--json"]);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ ok: true, capability: "operate", tool: "status" });
    expect(parsed.data.smoke.enabled).toBe(false);
    expect(parsed.data.smoke.envVar).toBe("PAPER_SEARCH_RUN_SMOKE");
    expect(parsed.data.smoke.reason).toContain("requires");
    expect(["healthy", "stale", "corrupt", "unavailable", "unknown"]).toContain(
      parsed.data.installation.health.status,
    );
    expect(parsed.data.installation.checks.sourceGit.status).not.toBeUndefined();
  });

  it("prints resolved status as JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-status-"));
    tempDirs.push(root);

    const configPath = path.join(root, "paper-search.toml");
    await writeFile(
      configPath,
      ["[workspace]", 'defaultCollection = "integration"', "", "[smoke]", "enabled = true", ""].join(
        "\n",
      ),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalEnv = process.env.PAPER_SEARCH_WORKSPACE_DEFAULT_COLLECTION;
    process.env.PAPER_SEARCH_WORKSPACE_DEFAULT_COLLECTION = "env-collection";
    process.chdir(root);

    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync(["node", "paper-search", "status", "--json"]);
    } finally {
      process.chdir(originalCwd);
      process.env.PAPER_SEARCH_WORKSPACE_DEFAULT_COLLECTION = originalEnv;
    }

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ ok: true, capability: "operate", tool: "status" });
    expect(parsed.data.workspace.defaultCollection).toBe("env-collection");
    expect(parsed.data.appliedEnvOverrides).toContain("PAPER_SEARCH_WORKSPACE_DEFAULT_COLLECTION");
    expect(parsed.data.smoke.enabled).toBe(false);
    expect(parsed.data.smoke.reason).toContain("requires");
  });

  it("warns when the provider install directory has no installed providers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-status-empty-providers-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const registryPath = path.join(root, "registry.json");
    await writeFile(registryPath, JSON.stringify({ providers: [] }), "utf8");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        `registryUrl = "${registryPath.replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    let stdout = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "status", "--json"]);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.installedProviderCounts).toEqual({
      search: { total: 0, valid: 0 },
      material: { total: 0, valid: 0 },
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No search providers are installed"),
        expect.stringContaining("No material providers are installed"),
      ]),
    );
  });

  it("does not warn about missing search providers when one is installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-status-with-provider-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    await mkdir(path.join(installDir, "fixture-academic"), { recursive: true });
    await writeFile(
      path.join(installDir, "fixture-academic", "manifest.json"),
      JSON.stringify({
        id: "fixture-academic",
        name: "Fixture Academic",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://fixture.example/*"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "fixture-academic", "provider.js"),
      "globalThis.__zrs_exports={createProvider(){return {async search(query){return {platform:'fixture-academic',query,totalResults:0,items:[],page:1};}}}};",
      "utf8",
    );
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        'registryUrl = "https://example.test/registry.json"',
        "",
      ].join("\n"),
      "utf8",
    );

    let stdout = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "status", "--json"]);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.diagnostics.installedProviderCounts.search).toEqual({ total: 1, valid: 1 });
    expect(parsed.warnings?.some((warning: string) => warning.includes("No search providers"))).toBeFalsy();
  });
});
