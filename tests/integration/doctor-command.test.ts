import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

describe("doctor command", () => {
  it("returns an operate envelope without leaking config or env secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-doctor-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const workspaceRoot = path.join(root, "workspace");
    const registryPath = path.join(root, "registry.json");
    const secretFromConfig = "tvly-do-not-emit";
    const providerSecret = "provider-secret-do-not-emit";
    const envSecret = "env-secret-do-not-emit";
    const appData = path.join(root, "appdata");

    await mkdir(path.join(installDir, "fixture-academic"), { recursive: true });
    await mkdir(path.join(appData, "paper-search"), { recursive: true });
    await writeFile(
      path.join(installDir, "fixture-academic", "manifest.json"),
      JSON.stringify({
        id: "fixture-academic",
        name: "Fixture Academic",
        version: "1.0.0",
        sourceType: "academic",
        permissions: { urls: ["https://fixture.example/*"] },
        configSchema: {
          apiKey: { type: "string", secret: true },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "fixture-academic", "provider.js"),
      "globalThis.__zrs_exports={createProvider(){return {async search(query){return {platform:'fixture-academic',query,totalResults:0,items:[],page:1};}}}};",
      "utf8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        providers: [{ id: "fixture-academic", version: "1.0.0", downloadUrl: "./fixture.zip" }],
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        `registryUrl = "${registryPath.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = "${workspaceRoot.replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(appData, "paper-search", "credentials.toml"),
      [
        "schemaVersion = 1",
        "",
        "[api.tavily]",
        `apiKey = "${secretFromConfig}"`,
        "",
        "[platform.fixture-academic]",
        `apiKey = "${providerSecret}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PAPER_SEARCH_API__EXA__API_KEY", envSecret);

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      })
        .exitOverride()
        .parseAsync(["node", "paper-search", "doctor"]);
    } finally {
      process.chdir(originalCwd);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }

    expect(stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout).not.toContain(secretFromConfig);
    expect(stdout).not.toContain(providerSecret);
    expect(stdout).not.toContain(envSecret);

    const parsed = JSON.parse(stdout);
    expect(isResultEnvelope(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "operate",
      tool: "doctor",
    });
    expect(parsed.data.providerInstallDir).toBe(installDir);
    expect(["healthy", "stale", "corrupt", "unavailable", "unknown"]).toContain(
      parsed.data.installation.health.status,
    );
    expect(parsed.data.installation.checks.cliIntegrity.status).not.toBeUndefined();
    expect(parsed.data.registry).toMatchObject({
      kind: "local",
      checked: true,
      reachable: true,
      providerCount: 1,
    });
    expect(parsed.data.manifestHealth.searchProviders).toMatchObject({
      total: 1,
      valid: 1,
      invalid: 0,
    });
    expect(parsed.data.workspace.writable).toBe(true);
    expect(parsed.data.mcp.status.protocolVersion).toBe("2024-11-05");
    expect(parsed.data.smoke).toMatchObject({
      enabled: false,
      envVar: "PAPER_SEARCH_RUN_SMOKE",
      envPresent: false,
    });
    expect(parsed.data.apiKeys.known).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "api",
          providerId: "tavily",
          key: "apiKey",
          status: "present",
          value: "<masked>",
          unused: true,
        }),
        expect.objectContaining({
          scope: "api",
          providerId: "exa",
          key: "apiKey",
          status: "present",
          value: "<masked>",
          unused: true,
        }),
        expect.objectContaining({
          scope: "platform",
          providerId: "fixture-academic",
          key: "apiKey",
          status: "present",
          value: "<masked>",
        }),
      ]),
    );
    expect(parsed.data.apiKeys.missing).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "api", providerId: "firecrawl", key: "apiKey" }),
        expect.objectContaining({ scope: "api", providerId: "xai", key: "apiKey" }),
      ]),
    );
    expect(parsed.data.externalSearch.state).toBe("disabled");
    expect(parsed.data.mcp.status.serverInfo.version).toBe("0.4.0");
  });

  it("does not fetch remote registries during readiness checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-doctor-remote-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    await mkdir(installDir, { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${installDir.replace(/\\/g, "\\\\")}"`,
        'registryUrl = "https://example.test/registry.json?token=registry-secret"',
        "",
      ].join("\n"),
      "utf8",
    );

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let stdout = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      })
        .exitOverride()
        .parseAsync(["node", "paper-search", "doctor"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdout).not.toContain("registry-secret");
    const parsed = JSON.parse(stdout);
    expect(parsed.data.registry).toMatchObject({
      kind: "url",
      checked: false,
      reachable: null,
    });
    expect(parsed.data.registry.source).toContain("token=%3Cmasked%3E");
  });

  it("warns with onboarding steps when no search or material providers are installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-doctor-empty-providers-"));
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
        stderr: { write() { /* ignore */ } },
      })
        .exitOverride()
        .parseAsync(["node", "paper-search", "doctor"]);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.installedProviderCounts).toEqual({
      search: { total: 0, valid: 0 },
      material: { total: 0, valid: 0 },
    });
    const searchWarning = parsed.warnings.find((warning: string) => warning.includes("No search providers are installed"));
    const materialWarning = parsed.warnings.find((warning: string) => warning.includes("No material providers are installed"));
    expect(searchWarning).toContain("registries add official-search");
    expect(searchWarning.toLowerCase()).toContain(registryPath.toLowerCase());
    expect(materialWarning).toContain("registries add official-material");
  });

  it("does not emit zero-provider warnings when a valid search provider is installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-doctor-with-provider-"));
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
        stderr: { write() { /* ignore */ } },
      })
        .exitOverride()
        .parseAsync(["node", "paper-search", "doctor"]);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.diagnostics.installedProviderCounts.search).toEqual({ total: 1, valid: 1 });
    expect(parsed.warnings?.some((warning: string) => warning.includes("No search providers"))).toBeFalsy();
  });
});
