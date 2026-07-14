import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const saved = {
  home: process.env.PAPER_SEARCH_HOME,
  appData: process.env.APPDATA,
  xdg: process.env.XDG_CONFIG_HOME,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("PAPER_SEARCH_HOME", saved.home);
  restore("APPDATA", saved.appData);
  restore("XDG_CONFIG_HOME", saved.xdg);
});

async function run(args: string[]): Promise<Record<string, any>> {
  let stdout = "";
  await buildProgram({
    stdout: { write(chunk: string) { stdout += chunk; } },
    stderr: { write() {} },
  }).exitOverride().parseAsync(["node", "paper-search", ...args]);
  return JSON.parse(stdout.trim()) as Record<string, any>;
}

describe("unified-home diagnostic commands", () => {
  it("reports one authority and keeps paths/status/doctor available during pending migration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-home-commands-"));
    const home = path.join(root, "home");
    const legacy = path.join(root, "appdata", "paper-search");
    process.env.PAPER_SEARCH_HOME = home;
    process.env.APPDATA = path.join(root, "appdata");
    process.env.XDG_CONFIG_HOME = path.join(root, "empty-xdg");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "config.toml"), "schemaVersion = 1\n[defaults]\nmaxResults = 44\n");

    const paths = await run(["paths", "--json"]);
    expect(paths.data).toMatchObject({
      paperSearchHome: home,
      configRoot: home,
      dataRoot: home,
      managedBinRoot: path.join(home, "bin"),
      workspace: path.join(home, "workspace"),
      runs: path.join(home, "runs"),
      configLocationMigration: { status: "pending", selectedSource: legacy },
    });

    const status = await run(["status", "--json"]);
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({
      configLocationMigration: { status: "pending" },
      storage: { artifactRoot: path.join(home, "storage", "artifacts") },
      runs: { root: path.join(home, "runs"), maxAgeDays: -1 },
    });
    expect(status.warnings).toEqual(expect.arrayContaining([expect.stringContaining("migration is pending")]));

    const doctor = await run(["doctor", "--json"]);
    expect(doctor.ok).toBe(true);
    expect(doctor.data.configLocationMigration.status).toBe("pending");

    const explain = await run(["config", "explain", "defaults.maxResults"]);
    expect(explain).toMatchObject({ ok: false, tool: "config_explain" });
    expect(explain.errors[0]).toContain("config_location_migration_required");
  });
});
