import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { registerProviderCommands } from "../../src/commands/providers.js";
import { providerTargetPath } from "../../src/providers/paths.js";
import { createIo } from "../../src/runtime/io.js";
import {
  executeSubscriptionMutation,
  refreshSubscriptions,
} from "../../src/subscriptions/service.js";
import type { ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const roots: string[] = [];
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

function currentEnv(): NodeJS.ProcessEnv {
  return process.env;
}

async function run(args: string[]): Promise<ResultEnvelope> {
  let stdout = "";
  const program = new Command().name("paper-search").helpCommand(false).exitOverride();
  registerProviderCommands(program, createIo({ stdout: { write(chunk) { stdout += chunk; } } }));
  await program.parseAsync(["node", "paper-search", ...args]);
  return JSON.parse(stdout) as ResultEnvelope;
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

describe("provider lifecycle commands", () => {
  it("lists validated candidates and keeps bound install plan-first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-lifecycle-cli-"));
    roots.push(root);
    setEnv("APPDATA", path.join(root, "appdata"));
    setEnv("PAPER_SEARCH_INSTALL_TEST_MODE", "1");
    setEnv("PAPER_SEARCH_TEST_DATA_ROOT", path.join(root, "data"));
    const registryDir = path.join(root, "registry");
    await mkdir(registryDir);
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      id: "alpha",
      name: "alpha",
      version: "1.0.0",
      sourceType: "academic",
      permissions: { urls: ["https://example.test/*"] },
    }));
    zip.file("provider.js", "globalThis.__zrs_exports={};");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const archivePath = path.join(registryDir, "alpha.zip");
    await writeFile(archivePath, bytes);
    const registryPath = path.join(registryDir, "registry.json");
    await writeFile(registryPath, JSON.stringify({ providers: [{
      id: "alpha",
      version: "1.0.0",
      downloadUrl: "alpha.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }] }));
    await executeSubscriptionMutation(
      { operation: "add", id: "local-source", url: registryPath, runtimeKind: "search" },
      true,
      currentEnv(),
    );
    await refreshSubscriptions("local-source", currentEnv());

    await expect(run(["providers", "available", "alpha", "--json"]))
      .resolves.toMatchObject({
        ok: true,
        tool: "providers_available",
        data: { candidates: [{ id: "alpha", subscriptionId: "local-source", status: "available" }] },
      });
    await expect(run(["providers", "install", "alpha", "--from", "local-source", "--json"]))
      .resolves.toMatchObject({
        ok: true,
        tool: "providers_install",
        planned: true,
        data: { applied: false, plan: { action: "install", binding: { subscriptionId: "local-source" } } },
      });
    await expect(access(providerTargetPath("search", "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run(["providers", "install", "alpha", "--from", "local-source", "--apply", "--json"]))
      .resolves.toMatchObject({
        ok: true,
        tool: "providers_install",
        planned: false,
        data: { applied: true, result: { id: "alpha", version: "1.0.0" } },
      });
  }, 10_000);
});
