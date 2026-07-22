import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { loadConfig } from "../../src/config/load.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveExternalSearchAdapter } from "../../src/external-search/adapters.js";
import { inspectExternalSearchStatic } from "../../src/external-search/config.js";
import { ExternalSearchError } from "../../src/external-search/errors.js";
import { runBoundedProcess } from "../../src/external-search/process.js";
import { probeExternalSearch, runExternalWebSearch } from "../../src/external-search/service.js";
import { runCanonicalTool } from "../../src/surface/toolRunner.js";
import { PaperSearchMcpServer } from "../../src/mcp/jsonRpc.js";
import { buildBatchTasks, runBatchTasks } from "../../src/batch/core.js";

const temporary: string[] = [];
const nativeFixture = path.resolve("tests/fixtures/external-search/native-cli.mjs");
const configuredFixture = path.resolve("tests/fixtures/external-search/configured-cli.mjs");
const adapterFixture = path.resolve("tests/fixtures/external-search/fixture-adapter.mjs");

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function config(): ResolvedConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: { ...structuredClone(DEFAULT_CONFIG.providers), installDir: "providers" },
    workspace: { ...structuredClone(DEFAULT_CONFIG.workspace), root: "workspace" },
    runs: { ...structuredClone(DEFAULT_CONFIG.runs), recordByDefault: false },
    meta: {
      cwd: process.cwd(), userConfigPath: "config.toml", projectConfigPath: null,
      explicitConfigPath: null, loadedFiles: [], appliedEnvOverrides: [],
    },
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "paper-search-external-"));
  temporary.push(value);
  return value;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processIsRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Configured external-search child ${pid} remained alive after cancellation`);
}

async function writeExternalConfig(
  configRoot: string,
  behavior = "normal",
  adapter = "native",
  configuredExecutable = configuredFixture,
): Promise<void> {
  await mkdir(configRoot, { recursive: true });
  const executableArgs = adapter === "native" ? [nativeFixture, behavior] : [configuredExecutable];
  await writeFile(path.join(configRoot, "external-search.toml"), [
    "schemaVersion = 1", "enabled = true", `adapter = "${adapter}"`, "timeoutMs = 2000", "",
    "[process]", `executable = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(executableArgs)}`, `workingDirectory = ${JSON.stringify(process.cwd())}`, "",
  ].join("\n"));
}

describe("external search runtime", () => {
  it("keeps missing and explicitly disabled config process-free", async () => {
    const configRoot = await root();
    expect((await inspectExternalSearchStatic({ configRoot })).state).toBe("disabled");
    await writeFile(path.join(configRoot, "external-search.toml"), "schemaVersion = 1\nenabled = false\n");
    expect((await inspectExternalSearchStatic({ configRoot })).state).toBe("disabled");
  });

  it("rejects execution authority in layered project config", async () => {
    const cwd = await root();
    await writeFile(path.join(cwd, "paper-search.toml"), [
      "schemaVersion = 1", "", "[externalSearch]", 'executable = "forbidden"', "",
    ].join("\n"));
    await expect(loadConfig({ cwd })).rejects.toThrow(/forbidden_config_authority/u);
  });

  it("runs strict native probe and search envelopes", async () => {
    const configRoot = await root();
    await writeExternalConfig(configRoot);
    const probe = await probeExternalSearch({ configRoot });
    expect(probe).toMatchObject({ ok: true, status: "ready", data: { tool: { name: "fixture-native" } } });
    const result = await runExternalWebSearch(config(), { query: "  offline   query ", mode: "fast", maxResults: 2 }, { configRoot });
    expect(result).toMatchObject({
      ok: true,
      data: { query: "offline query", results: [{ title: "Fixture result", publishedAt: "2026-07-14" }] },
    });
  });

  it("keeps canonical, MCP discovery, and batch projections on the one generic handler", async () => {
    const configRoot = await root();
    await writeExternalConfig(configRoot);
    const oldHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = configRoot;
    try {
      const resolved = config();
      const canonical = await runCanonicalTool(resolved, "web_search", { query: "canonical" });
      expect(canonical).toMatchObject({ ok: true, tool: "web_search", data: { query: "canonical" } });
      const removed = await runCanonicalTool(
        resolved,
        "web_search",
        { query: "canonical", provider: "tavily" },
      );
      expect(removed).toMatchObject({ ok: false, diagnostics: { reason: "invalid_arguments" } });

      const mcp = new PaperSearchMcpServer(resolved);
      const listed = await mcp.handleMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      const tools = (JSON.parse(listed.body).result.tools as Array<{ name: string }>).map((entry) => entry.name);
      expect(tools).toContain("web_search");
      expect(tools).not.toContain("web_research");

      const tasks = buildBatchTasks([{ tool: "web_search", query: "batch", mode: "fast" }], {
        addMode: "none", collectionMap: {}, extraTags: [], fetchPdf: false,
        includeRaw: true, skipStatuses: new Set(),
      });
      const [batch] = await runBatchTasks({ config: resolved }, tasks, {
        concurrency: 1, failFast: false, includeRaw: true,
      });
      expect(batch).toMatchObject({ status: "ok", tool: "web_search" });
    } finally {
      if (oldHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = oldHome;
    }
  });

  it("keeps disabled batch invocation on the typed external-search failure", async () => {
    const configRoot = await root();
    const oldHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = configRoot;
    try {
      const tasks = buildBatchTasks([{ tool: "web_search", query: "batch" }], {
        addMode: "none", collectionMap: {}, extraTags: [], fetchPdf: false,
        includeRaw: false, skipStatuses: new Set(),
      });
      const [batch] = await runBatchTasks({ config: config() }, tasks, {
        concurrency: 1, failFast: false, includeRaw: false,
      });
      expect(batch).toMatchObject({
        status: "error",
        ok: false,
        tool: "web_search",
        diagnostics: { reason: "external_search_disabled" },
      });
    } finally {
      if (oldHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = oldHome;
    }
  });

  it("runs a trusted adapter only through the child host", async () => {
    const configRoot = await root();
    await mkdir(path.join(configRoot, "adapters"), { recursive: true });
    await copyFile(adapterFixture, path.join(configRoot, "adapters", "fixture.mjs"));
    await writeExternalConfig(configRoot, "normal", "fixture");
    const probe = await probeExternalSearch({ configRoot });
    expect(probe).toMatchObject({ ok: true, data: { tool: { name: "fixture-cli" } } });
    const result = await runExternalWebSearch(config(), { query: "adapt me" }, { configRoot });
    expect(result).toMatchObject({ ok: true, data: { results: [{ title: "Adapted result" }] } });
  });

  it.each([
    ["malformed", "malformed_json"],
    ["request-mismatch", "request_id_mismatch"],
    ["version-mismatch", "protocol_incompatible"],
    ["exit", "process_nonzero_exit"],
    ["timeout", "process_timeout"],
    ["overflow", "process_output_limit"],
  ])("classifies %s failures", async (behavior, code) => {
    const configRoot = await root();
    await writeExternalConfig(configRoot, behavior);
    await expect(probeExternalSearch({ configRoot })).rejects.toMatchObject({ code });
  });

  it("supports caller cancellation", async () => {
    const controller = new AbortController();
    const execution = runBoundedProcess({
      executable: process.execPath, args: [nativeFixture, "timeout"], cwd: process.cwd(),
      stdin: "{}", timeoutMs: 5_000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(execution).rejects.toMatchObject({ code: "process_cancelled" });
  });

  it("cancels the configured child process behind a custom adapter", async () => {
    const configRoot = await root();
    await mkdir(path.join(configRoot, "adapters"), { recursive: true });
    await copyFile(adapterFixture, path.join(configRoot, "adapters", "fixture.mjs"));
    const cancellableFixture = path.join(configRoot, "cancellable-cli.mjs");
    await writeFile(cancellableFixture, [
      'import { writeFileSync } from "node:fs";',
      'if (!process.env.PAPER_SEARCH_TEST_READY_FILE) process.exit(2);',
      'writeFileSync(process.env.PAPER_SEARCH_TEST_READY_FILE, `${process.pid}\\n`);',
      'setTimeout(() => {}, 60_000);',
      '',
    ].join("\n"));
    await writeExternalConfig(configRoot, "normal", "fixture", cancellableFixture);
    const readyFile = path.join(configRoot, "child-ready");
    const oldReady = process.env.PAPER_SEARCH_TEST_READY_FILE;
    const controller = new AbortController();
    let childPid: number | undefined;
    let childExited = false;
    process.env.PAPER_SEARCH_TEST_READY_FILE = readyFile;
    try {
      const execution = runExternalWebSearch(
        config(), { query: "__hang__" }, { configRoot, signal: controller.signal },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await access(readyFile).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await expect(access(readyFile)).resolves.toBeUndefined();
      childPid = Number.parseInt((await readFile(readyFile, "utf8")).trim(), 10);
      expect(childPid).toBeGreaterThan(0);
      controller.abort();
      await expect(execution).rejects.toMatchObject({ code: "process_cancelled" });
      await waitForProcessExit(childPid);
      childExited = true;
    } finally {
      controller.abort();
      if (childPid && !childExited) {
        try {
          process.kill(childPid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (oldReady === undefined) delete process.env.PAPER_SEARCH_TEST_READY_FILE;
      else process.env.PAPER_SEARCH_TEST_READY_FILE = oldReady;
    }
  });

  it("redacts secret-like child diagnostics", async () => {
    const configRoot = await root();
    await writeExternalConfig(configRoot, "exit");
    let caught: unknown;
    try {
      await probeExternalSearch({ configRoot });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalSearchError);
    expect((caught as Error).message).toContain("api_key=[redacted]");
    expect((caught as Error).message).not.toContain("fixture-secret");
  });

  it("redacts configured CLI stderr before exposing it to an adapter", async () => {
    const configRoot = await root();
    await mkdir(path.join(configRoot, "adapters"), { recursive: true });
    await copyFile(adapterFixture, path.join(configRoot, "adapters", "fixture.mjs"));
    await writeExternalConfig(configRoot, "normal", "fixture");
    const response = await runExternalWebSearch(config(), { query: "__stderr__" }, { configRoot });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "fixture_failure", message: "token=[redacted] must not escape" },
    });
    expect(JSON.stringify(response)).not.toContain("adapter-secret");
  });

  it("rejects lexical adapter escape names", async () => {
    const configRoot = await root();
    await expect(resolveExternalSearchAdapter(configRoot, "../escape")).rejects.toMatchObject({ code: "adapter_invalid" });
    await expect(resolveExternalSearchAdapter(configRoot, path.resolve("escape"))).rejects.toMatchObject({ code: "adapter_invalid" });
  });

  it("rejects realpath adapter escapes when symlinks are supported", async () => {
    const configRoot = await root();
    const outside = await root();
    await mkdir(path.join(configRoot, "adapters"), { recursive: true });
    await writeFile(path.join(outside, "escape.mjs"), "export const value = true;\n");
    try {
      await symlink(path.join(outside, "escape.mjs"), path.join(configRoot, "adapters", "escape.mjs"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(resolveExternalSearchAdapter(configRoot, "escape")).rejects.toMatchObject({ code: "adapter_invalid" });
  });
});
