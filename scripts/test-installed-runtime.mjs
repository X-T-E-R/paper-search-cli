#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDist = path.join(repoRoot, "dist");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-installed-runtime-"));
const runtimeRoot = path.join(temporaryRoot, "runtime");
const homeRoot = path.join(temporaryRoot, "home");
const cliPath = path.join(runtimeRoot, "cli.js");
const providerInstallRoot = path.join(temporaryRoot, "providers");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const configPath = path.join(temporaryRoot, "paper-search.toml");

const isolatedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name !== "NODE_PATH" && !name.startsWith("PAPER_SEARCH_"),
  ),
);

function run(args, input) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: temporaryRoot,
    env: {
      ...isolatedEnv,
      APPDATA: path.join(homeRoot, "appdata"),
      LOCALAPPDATA: path.join(homeRoot, "localappdata"),
      USERPROFILE: homeRoot,
      HOME: homeRoot,
      XDG_CONFIG_HOME: path.join(homeRoot, ".config"),
      NODE_PATH: "",
    },
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `installed runtime ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function parseEnvelope(output, label) {
  const value = JSON.parse(output);
  if (value?.ok !== true) throw new Error(`${label} did not return a successful envelope`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixtureZip(fixtureRoot, outputPath) {
  const archive = new JSZip();
  for (const name of ["manifest.json", "provider.js"]) {
    archive.file(name, await readFile(path.join(fixtureRoot, name)));
  }
  const bytes = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
  await writeFile(outputPath, bytes);
  return sha256(bytes);
}

async function assertNoReachableNodeModules(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    try {
      await access(path.join(current, "node_modules"));
      throw new Error(`installed runtime can reach node_modules at ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

try {
  await cp(sourceDist, runtimeRoot, { recursive: true });
  await assertNoReachableNodeModules(runtimeRoot);
  await writeFile(
    configPath,
    [
      "[providers]",
      `installDir = ${JSON.stringify(providerInstallRoot)}`,
      "",
      "[workspace]",
      `root = ${JSON.stringify(workspaceRoot)}`,
      'defaultCollection = "Inbox"',
      "",
    ].join("\n"),
  );
  const build = JSON.parse(await readFile(path.join(runtimeRoot, "build.json"), "utf8"));
  const version = run(["--version"]).trim();
  if (version !== build.packageVersion) {
    throw new Error(`version mismatch: build=${build.packageVersion}, CLI=${version}`);
  }
  if (!run(["--help"]).includes("Usage: paper-search")) {
    throw new Error("--help did not expose the Paper Search command catalog");
  }
  const tools = JSON.parse(run(["tools", "--json"]));
  if (!Array.isArray(tools?.tools) && !Array.isArray(tools?.data?.tools)) {
    throw new Error("tools --json did not expose a tool catalog");
  }
  const status = JSON.parse(run(["status", "--json"]));
  if (status?.ok !== true || status?.tool !== "status") {
    throw new Error("status --json did not return a successful installed-runtime envelope");
  }

  const searchFixture = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "provider-packages",
    "fixture-academic-searchable",
  );
  const searchZip = path.join(temporaryRoot, "fixture-academic-searchable.zip");
  const searchRegistry = path.join(temporaryRoot, "search-registry.json");
  const searchSha256 = await writeFixtureZip(searchFixture, searchZip);
  await writeFile(
    searchRegistry,
    JSON.stringify({
      providers: [
        {
          id: "fixture-academic-searchable",
          version: "1.0.0",
          downloadUrl: searchZip,
          sha256: searchSha256,
          minPluginVersion: "0.1.0",
        },
      ],
    }),
  );
  parseEnvelope(
    run(["--config", configPath, "providers", "plan-registry", searchRegistry, "--json"]),
    "search registry plan",
  );
  parseEnvelope(
    run([
      "--config",
      configPath,
      "providers",
      "sync-registry",
      searchRegistry,
      "--apply",
      "--json",
    ]),
    "search registry apply",
  );
  parseEnvelope(
    run([
      "--config",
      configPath,
      "academic",
      "installed runtime probe",
      "--platform",
      "fixture-academic-searchable",
    ]),
    "installed search provider",
  );

  const materialFixture = path.join(
    repoRoot,
    "tests",
    "fixtures",
    "material-provider-packages",
    "fixture-extractor",
  );
  const materialZip = path.join(temporaryRoot, "fixture-extractor.zip");
  const materialRegistry = path.join(temporaryRoot, "material-registry.json");
  const materialSha256 = await writeFixtureZip(materialFixture, materialZip);
  await writeFile(
    materialRegistry,
    JSON.stringify({
      providers: [
        {
          id: "fixture-extractor",
          version: "1.0.0",
          kind: "extractor",
          downloadUrl: materialZip,
          sha256: materialSha256,
          minCliVersion: "0.1.0",
        },
      ],
    }),
  );
  parseEnvelope(
    run([
      "--config",
      configPath,
      "providers",
      "plan-registry",
      materialRegistry,
      "--kind",
      "material",
      "--json",
    ]),
    "material registry plan",
  );
  parseEnvelope(
    run([
      "--config",
      configPath,
      "providers",
      "sync-registry",
      materialRegistry,
      "--kind",
      "material",
      "--apply",
      "--json",
    ]),
    "material registry apply",
  );
  parseEnvelope(
    run([
      "--config",
      configPath,
      "providers",
      "inspect-package",
      path.join(providerInstallRoot, "material", "fixture-extractor"),
      "--kind",
      "material",
      "--json",
    ]),
    "installed material provider",
  );

  parseEnvelope(
    run([
      "--config",
      configPath,
      "resource-add",
      "--url",
      "https://example.test/runtime",
      "--title",
      "Installed Runtime Resource",
      "--json",
    ]),
    "workspace resource add",
  );
  const batchPath = path.join(temporaryRoot, "batch.json");
  const batchOutputPath = path.join(temporaryRoot, "batch-results.jsonl");
  await writeFile(
    batchPath,
    JSON.stringify([
      {
        task_id: "runtime-batch-1",
        tool: "resource_add",
        target_collection: "Runtime",
        item: {
          itemType: "journalArticle",
          title: "Installed Runtime Batch Resource",
          url: "https://example.test/runtime-batch",
        },
      },
    ]),
  );
  run(["--config", configPath, "batch", batchPath, "--out", batchOutputPath]);
  const batchRows = (await readFile(batchOutputPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (batchRows.length !== 1 || batchRows[0]?.status !== "ok") {
    throw new Error("installed runtime batch contract did not complete its resource_add row");
  }

  const mcpOutput = run(
    ["--config", configPath, "mcp", "serve", "--transport", "stdio"],
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      "",
    ].join("\n"),
  );
  const mcpResponses = mcpOutput
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    mcpResponses[0]?.result?.protocolVersion !== "2024-11-05" ||
    !Array.isArray(mcpResponses[1]?.result?.tools)
  ) {
    throw new Error("installed runtime MCP stdio contract returned an invalid response");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      packageVersion: version,
      launcherProtocol: build.launcherProtocol,
      probes: ["catalog", "status", "search-registry", "material-registry", "workspace", "batch", "mcp-stdio"],
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
