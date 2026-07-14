import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerRegistriesCommands } from "../../src/commands/registries.js";
import { resolveConfigBundlePaths } from "../../src/config/paths.js";
import { createIo } from "../../src/runtime/io.js";
import type { ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const roots: string[] = [];
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function run(args: string[]): Promise<{ stdout: string; envelope: ResultEnvelope }> {
  let stdout = "";
  const program = new Command().name("paper-search").helpCommand(false).exitOverride();
  registerRegistriesCommands(program, createIo({ stdout: { write(chunk) { stdout += chunk; } } }));
  await program.parseAsync(["node", "paper-search", ...args]);
  return { stdout, envelope: JSON.parse(stdout) as ResultEnvelope };
}

describe("registries command", () => {
  it("keeps trust changes plan-first and refreshes metadata explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-registries-cli-"));
    roots.push(root);
    setEnv("APPDATA", path.join(root, "appdata"));
    setEnv("PAPER_SEARCH_INSTALL_TEST_MODE", "1");
    setEnv("PAPER_SEARCH_TEST_DATA_ROOT", path.join(root, "data"));
    const source = path.join(root, "registry.json");
    await writeFile(source, JSON.stringify({ providers: [
      { id: "alpha", version: "1.0.0", downloadUrl: "alpha.zip", sha256: "a".repeat(64) },
    ] }));

    const plan = await run(["registries", "add", "local-search", source, "--kind", "search"]);
    expect(plan.envelope).toMatchObject({ ok: true, tool: "registries_add", planned: true, data: { applied: false } });
    await expect(readFile(resolveConfigBundlePaths().subscriptions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await run(["registries", "add", "local-search", source, "--kind", "search", "--apply"]);
    expect(applied.envelope).toMatchObject({ ok: true, tool: "registries_add", planned: false, data: { applied: true } });
    const listed = await run(["registries", "list"]);
    expect(listed.envelope).toMatchObject({ ok: true, data: [{ id: "local-search", status: "active" }] });
    const refreshed = await run(["registries", "refresh", "local-search"]);
    expect(refreshed.envelope).toMatchObject({
      ok: true,
      tool: "registries_refresh",
      planned: false,
      data: [{ candidates: [{ id: "alpha", status: "available" }] }],
    });
  });
});
