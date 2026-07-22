import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  configureProviderInteractive,
  listProviderSetup,
  type ConfigurePrompt,
  type ProviderSetupDescriptor,
} from "../../src/commands/configure.js";
import { buildProgram } from "../../src/program.js";
import { readHiddenCredential } from "../../src/config/credentialInput.js";

const roots: string[] = [];
const originalHome = process.env.PAPER_SEARCH_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PAPER_SEARCH_HOME;
  else process.env.PAPER_SEARCH_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(): Promise<{ root: string; installDir: string; config: ResolvedConfig; descriptor: ProviderSetupDescriptor }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-configure-"));
  roots.push(root);
  process.env.PAPER_SEARCH_HOME = path.join(root, "home");
  const installDir = path.join(root, "providers");
  const providerDir = path.join(installDir, "search", "setup-test");
  await mkdir(providerDir, { recursive: true });
  await writeFile(path.join(providerDir, "provider.js"), "export default () => ({ search: async () => ({}) });\n");
  await writeFile(path.join(providerDir, "manifest.json"), JSON.stringify({
    id: "setup-test",
    name: "Setup Test",
    version: "1.0.0",
    sourceType: "academic",
    permissions: { urls: ["https://example.com/*"] },
    configSchema: {
      email: { type: "string", required: true, label: "Contact email", placeholder: "you@example.com" },
      apiKey: { type: "string", required: true, secret: true, label: "API key" },
    },
  }));
  const defaultOffDir = path.join(installDir, "search", "default-off");
  await mkdir(defaultOffDir, { recursive: true });
  await writeFile(path.join(defaultOffDir, "provider.js"), "export default () => ({ search: async () => ({}) });\n");
  await writeFile(path.join(defaultOffDir, "manifest.json"), JSON.stringify({
    id: "default-off",
    name: "Default Off",
    version: "1.0.0",
    sourceType: "academic",
    permissions: { urls: ["https://example.com/*"] },
    configSchema: { enabled: { type: "boolean", default: false } },
  }));
  const config: ResolvedConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    providers: { ...structuredClone(DEFAULT_CONFIG.providers), installDir },
    platform: {},
    meta: {
      cwd: root,
      userConfigPath: path.join(root, "home", "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
  return {
    root,
    installDir,
    config,
    descriptor: {
      id: "setup-test",
      name: "Setup Test",
      kind: "search",
      intent: "auto",
      enabled: true,
      configured: false,
      missingConfigKeys: ["email", "apiKey"],
      schema: {
        email: { type: "string", required: true, label: "Contact email", placeholder: "you@example.com" },
        apiKey: { type: "string", required: true, secret: true, label: "API key" },
      },
    },
  };
}

describe.sequential("configure command", () => {
  it("uses visible input for non-secret fields and hidden input only for secrets", async () => {
    const value = await fixture();
    const visible = vi.fn(async () => "researcher@example.org");
    const hidden = vi.fn(async () => "test-secret-value");
    const prompt: ConfigurePrompt = { choose: async () => "now", visible, hidden };

    await expect(configureProviderInteractive(value.config, value.descriptor, prompt)).resolves.toEqual({
      decision: "now",
      configured: true,
    });
    expect(visible).toHaveBeenCalledWith("Contact email", "you@example.com");
    expect(hidden).toHaveBeenCalledWith("API key");
    const publicConfig = await readFile(path.join(value.root, "home", "config.toml"), "utf8");
    const credentials = await readFile(path.join(value.root, "home", "credentials.toml"), "utf8");
    expect(publicConfig).toContain('email = "researcher@example.org"');
    expect(publicConfig).toContain("enabled = true");
    expect(publicConfig).not.toContain("test-secret-value");
    expect(credentials).toContain('apiKey = "test-secret-value"');
    expect(credentials).not.toContain("researcher@example.org");
  });

  it("preserves auto on later and writes enabled=false on disable", async () => {
    const later = await fixture();
    const unused = vi.fn(async () => "unused");
    await expect(configureProviderInteractive(later.config, later.descriptor, {
      choose: async () => "later",
      visible: unused,
      hidden: unused,
    })).resolves.toEqual({ decision: "later", configured: false });
    await expect(readFile(path.join(later.root, "home", "config.toml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const disabled = await fixture();
    await configureProviderInteractive(disabled.config, disabled.descriptor, {
      choose: async () => "disable",
      visible: unused,
      hidden: unused,
    });
    expect(await readFile(path.join(disabled.root, "home", "config.toml"), "utf8")).toContain("enabled = false");
    expect(unused).not.toHaveBeenCalled();
  });

  it("emits actions in JSON mode without touching stdin", async () => {
    const value = await fixture();
    const configPath = path.join(value.root, "paper-search.toml");
    await writeFile(configPath, `[providers]\ninstallDir = "${value.installDir.replace(/\\/g, "\\\\")}"\n`);
    let stdout = "";
    const stdinOn = vi.spyOn(process.stdin, "on");
    await buildProgram({ stdout: { write(chunk: string) { stdout += chunk; } } })
      .exitOverride()
      .parseAsync(["node", "paper-search", "--config", configPath, "configure", "setup-test", "--json"]);
    expect(stdinOn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      tool: "configure",
      actions: [{ command: "paper-search configure setup-test" }],
    });
  });

  it("allows exact configure to enable default-off and explicitly disabled providers", async () => {
    const defaultOff = await fixture();
    await expect(listProviderSetup(defaultOff.config)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "default-off" })]),
    );
    const [defaultOffDescriptor] = await listProviderSetup(defaultOff.config, "default-off");
    expect(defaultOffDescriptor).toMatchObject({
      configured: true,
      enabled: false,
      intent: "auto",
      action: { command: "paper-search configure default-off" },
    });

    const disabled = await fixture();
    disabled.config.platform = {
      "setup-test": {
        enabled: false,
        email: "researcher@example.org",
        apiKey: "configured-test-value",
      },
    };
    const [descriptor] = await listProviderSetup(disabled.config, "setup-test");
    expect(descriptor).toMatchObject({ configured: true, enabled: false, intent: "disabled" });
    const unused = vi.fn(async () => "unused");
    await configureProviderInteractive(disabled.config, descriptor!, {
      choose: async () => "now",
      visible: unused,
      hidden: unused,
    });
    expect(await readFile(path.join(disabled.root, "home", "config.toml"), "utf8")).toContain("enabled = true");
    expect(unused).not.toHaveBeenCalled();
  });

  it("shows the field label while hidden credential input remains unechoed", async () => {
    const input = new EventEmitter() as ReadStream;
    Object.assign(input, {
      isTTY: true,
      setRawMode: vi.fn(),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
    const write = vi.fn();
    const output = { isTTY: true, write } as unknown as WriteStream;
    const pending = readHiddenCredential(input, output, "API key");
    input.emit("data", "hidden-test-value\n");
    await expect(pending).resolves.toBe("hidden-test-value");
    expect(write).toHaveBeenNthCalledWith(1, "API key: ");
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining("hidden-test-value"));
  });
});
