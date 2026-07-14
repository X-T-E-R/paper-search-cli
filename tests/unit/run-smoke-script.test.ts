import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(".");

interface SmokeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function smokeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
  };
  for (const key of [
    "PAPER_SEARCH_RUN_SMOKE",
    "PAPER_SEARCH_SMOKE_ENV_VAR",
    "PAPER_SEARCH_SMOKE_CASES",
    "PAPER_SEARCH_SMOKE_MATERIAL_PROVIDER_PACKAGE",
    "PAPER_SEARCH_SMOKE_MINERU_URL",
    "PAPER_SEARCH_SMOKE_MINERU_TIMEOUT_MS",
    "PAPER_SEARCH_SMOKE_MINERU_POLL_INTERVAL_MS",
    "PAPER_SEARCH_SMOKE_MINERU_MODEL_VERSION",
    "PAPER_SEARCH_SMOKE_MINERU_LANGUAGE",
    "PAPER_SEARCH_SMOKE_MINERU_PAGE_RANGES",
    "MINERU_TOKEN",
    "MINERU_API_TOKEN",
    "MINERU_API_BASE",
    "MINERU_ENDPOINT",
    "PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL",
    "PAPER_SEARCH_SMOKE_UNPAYWALL_DOI",
    "PAPER_SEARCH_SMOKE_UNPAYWALL_PROVIDER_PACKAGE",
    "PAPER_SEARCH_SMOKE_UNPAYWALL_TIMEOUT_MS",
    "UNPAYWALL_EMAIL",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    ...overrides,
  };
}

function runSmokeScript(args: string[], env: NodeJS.ProcessEnv): Promise<SmokeRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-smoke.mjs", ...args], {
      cwd: packageRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`run-smoke.mjs timed out with stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("run-smoke script gating", () => {
  it("reports a skipped JSON summary without the gate even when material live is selected", async () => {
    const result = await runSmokeScript(["--case", "material-mineru-live"], smokeEnv());

    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe("");
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      enabled: boolean;
      skipped: boolean;
      envVar: string;
      selectedCases: string[];
      availableCases: string[];
      message: string;
    };
    expect(summary).toMatchObject({
      ok: true,
      enabled: false,
      skipped: true,
      envVar: "PAPER_SEARCH_RUN_SMOKE",
      selectedCases: ["material-mineru-live"],
    });
    expect(summary.availableCases).toContain("material-mineru-live");
    expect(summary.message).toContain("Smoke tests skipped");
  });

  it("fails a selected material live case for missing credentials only after the gate is enabled", async () => {
    const result = await runSmokeScript(
      ["--case", "material-mineru-live"],
      smokeEnv({ PAPER_SEARCH_RUN_SMOKE: "1" }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe("");
    const summary = JSON.parse(result.stderr) as {
      ok: boolean;
      enabled: boolean;
      error: string;
    };
    expect(summary).toMatchObject({
      ok: false,
      enabled: true,
    });
    expect(summary.error).toContain("material-mineru-live requires");
    expect(summary.error).toContain("MINERU_TOKEN");
    expect(summary.error).toContain("MINERU_API_TOKEN");
    expect(summary.error).toContain("PAPER_SEARCH_SMOKE_MINERU_URL");
    expect(summary.error).not.toContain("Missing build artifact");
  });

  it("reports a skipped JSON summary without the gate when material-unpaywall-live is selected", async () => {
    const result = await runSmokeScript(["--case", "material-unpaywall-live"], smokeEnv());

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as { skipped: boolean; selectedCases: string[]; availableCases: string[] };
    expect(summary.skipped).toBe(true);
    expect(summary.selectedCases).toEqual(["material-unpaywall-live"]);
    expect(summary.availableCases).toContain("material-unpaywall-live");
  });

  it("fails material-unpaywall-live for missing email only after the gate is enabled", async () => {
    const result = await runSmokeScript(
      ["--case", "material-unpaywall-live"],
      smokeEnv({ PAPER_SEARCH_RUN_SMOKE: "1" }),
    );

    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stderr) as { ok: boolean; error: string };
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("material-unpaywall-live requires");
    expect(summary.error).toContain("PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL");
  });
});
