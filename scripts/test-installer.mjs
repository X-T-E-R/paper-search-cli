#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installerPath = path.join(repoRoot, "scripts", "install.mjs");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-installer-test-"));
const dataRoot = path.join(temporaryRoot, "data");
const skillsRoot = path.join(temporaryRoot, "skills");
const binRoot = path.join(temporaryRoot, "bin with & marker");
const projectionPath = path.join(skillsRoot, "paper-search-cli");
const journalPath = path.join(dataRoot, "state", "setup-journal.json");
const statePath = path.join(dataRoot, "state", "install.json");

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [installerPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: dataRoot,
      APPDATA: path.join(temporaryRoot, "appdata"),
      XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
      HOME: path.join(temporaryRoot, "user-home"),
      USERPROFILE: path.join(temporaryRoot, "user-home"),
      ...extraEnv,
    },
    encoding: "utf8",
    windowsHide: true,
  });
}

function assertSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

try {
  const dryRoot = path.join(temporaryRoot, "dry-skills");
  const dry = run(["--target", dryRoot, "--bin-dir", path.join(temporaryRoot, "dry-bin"), "--json"]);
  assertSuccess(dry, "dry-run");
  const dryPlan = JSON.parse(dry.stdout);
  if (
    dryPlan.mode !== "plan" ||
    dryPlan.blocked ||
    dryPlan.configRoot !== dataRoot ||
    dryPlan.dataRoot !== dataRoot ||
    dryPlan.configLocationMigration?.status !== "none" ||
    await lstat(dryRoot).then(() => true, () => false)
  ) {
    throw new Error("dry-run changed the filesystem or returned an invalid plan");
  }

  // Fold config-location recovery into the existing setup-recovery sequence so
  // this installer test does not perform two extra isolated release builds.
  const migrationLegacyRoot = path.join(temporaryRoot, "appdata", "paper-search");
  await mkdir(path.join(migrationLegacyRoot, "config.d"), { recursive: true });
  await writeFile(path.join(migrationLegacyRoot, "config.toml"), "schemaVersion = 1\n[defaults]\nmaxResults = 17\n", "utf8");
  await writeFile(path.join(migrationLegacyRoot, "credentials.toml"), "schemaVersion = 1\n", "utf8");
  await writeFile(path.join(migrationLegacyRoot, "config.d", "20-output.toml"), "[output]\nlocale = \"en-US\"\n", "utf8");
  const migrationPlanResult = run(["--target", skillsRoot, "--bin-dir", binRoot, "--json"]);
  assertSuccess(migrationPlanResult, "config-location migration plan");
  const migrationPlan = JSON.parse(migrationPlanResult.stdout);
  const firstMigrationEntry = migrationPlan.configLocationMigration?.entries?.[0];
  if (migrationPlan.configLocationMigration?.status !== "pending" || !firstMigrationEntry?.relativePath) {
    throw new Error("installer did not plan the legacy config-location migration");
  }

  const first = run(
    ["--target", skillsRoot, "--bin-dir", binRoot, "--apply", "--json"],
    { PAPER_SEARCH_TEST_FAIL_AFTER: `config-location:${firstMigrationEntry.relativePath}` },
  );
  if (first.status === 0 || !first.stderr.includes("Injected config-location migration interruption")) {
    throw new Error(`expected injected interruption, got ${first.status}: ${first.stderr}`);
  }
  const migrationReceiptPath = path.join(dataRoot, "state", "migrations", "config-location-v1.json");
  const migrationJournalPath = path.join(dataRoot, "state", "migrations", "config-location-v1.pending.json");
  if (!await lstat(path.join(dataRoot, ...firstMigrationEntry.relativePath.split("/"))).then(() => true, () => false)) {
    throw new Error("injected config-location interruption did not copy its first entry");
  }
  await lstat(migrationJournalPath);

  const migrationRecovered = run(
    ["--target", skillsRoot, "--bin-dir", binRoot, "--apply", "--json"],
    { PAPER_SEARCH_TEST_FAIL_AFTER: `projection:${projectionPath}` },
  );
  if (migrationRecovered.status === 0 || !migrationRecovered.stderr.includes("Injected setup interruption")) {
    throw new Error(`expected setup interruption after config-location recovery, got ${migrationRecovered.status}: ${migrationRecovered.stderr}`);
  }
  for (const relativePath of ["config.toml", "credentials.toml", "config.d/20-output.toml"]) {
    const destination = await readFile(path.join(dataRoot, ...relativePath.split("/")), "utf8");
    const source = await readFile(path.join(migrationLegacyRoot, ...relativePath.split("/")), "utf8");
    if (destination !== source) throw new Error(`config-location recovery did not restore ${relativePath}`);
  }
  const migrationReceipt = JSON.parse(await readFile(migrationReceiptPath, "utf8"));
  if (migrationReceipt.schemaVersion !== 1 || migrationReceipt.status !== "complete" || migrationReceipt.sourceRoot !== migrationLegacyRoot) {
    throw new Error("config-location recovery did not write a valid receipt");
  }
  if (await lstat(migrationJournalPath).then(() => true, () => false)) {
    throw new Error("config-location recovery left its pending journal behind");
  }
  await lstat(journalPath);

  const recovered = run(["--target", skillsRoot, "--bin-dir", binRoot, "--apply", "--json"]);
  assertSuccess(recovered, "recovery apply");
  const recoveryResult = JSON.parse(recovered.stdout);
  if (!recoveryResult.ok || !recoveryResult.recovered) {
    throw new Error("recovery apply did not report journal recovery");
  }
  const projectionTarget = await realpath(projectionPath);
  const expectedTarget = await realpath(path.join(repoRoot, "skills", "paper-search-cli"));
  if (projectionTarget !== expectedTarget) throw new Error("projected skill target mismatch");

  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.projections.length !== 1 || state.sourceManagementMode !== "user-managed") {
    throw new Error("install state does not own the recovered projection");
  }
  const expectedShimCount = process.platform === "win32" ? 3 : 2;
  if (state.shims.length !== expectedShimCount || state.shims.some((entry) => !entry.sha256)) {
    throw new Error("install state does not record every generated shim and content hash");
  }
  if (await lstat(journalPath).then(() => true, () => false)) {
    throw new Error("completed recovery left the setup journal behind");
  }
  const eventDirectory = path.join(dataRoot, "state", "events");
  const eventFiles = (await readdir(eventDirectory)).filter((entry) => entry.endsWith(".jsonl"));
  if (eventFiles.length !== 1) throw new Error("setup did not write exactly one monthly lifecycle ledger");
  const eventLines = (await readFile(path.join(eventDirectory, eventFiles[0]), "utf8"))
    .trim()
    .split("\n");
  if (eventLines.length !== 1) throw new Error("recovered setup wrote duplicate lifecycle events");
  const setupEvent = JSON.parse(eventLines[0]);
  if (
    setupEvent.command !== "setup" ||
    setupEvent.outcome !== "applied" ||
    setupEvent.planDigest !== recoveryResult.plan.planDigest ||
    typeof setupEvent.operationId !== "string"
  ) {
    throw new Error("setup lifecycle event is missing its operation or plan identity");
  }
  const launcher = path.join(projectionPath, "scripts", "paper-search.mjs");
  const version = spawnSync(process.execPath, [launcher, "--version"], {
    cwd: temporaryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assertSuccess(version, "projected launcher");

  const bridge = spawnSync(process.execPath, [path.join(binRoot, "paper-search.mjs"), "--version"], {
    cwd: temporaryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assertSuccess(bridge, "installed bin bridge");
  if (bridge.stdout.trim() !== version.stdout.trim()) {
    throw new Error("installed bin bridge returned a different version");
  }

  if (process.platform === "win32") {
    const commandPath = path.join(binRoot, "paper-search.cmd");
    const command = spawnSync(process.env.ComSpec ?? "cmd.exe", [
      "/d",
      "/s",
      "/c",
      `""${commandPath}" --version"`,
    ], {
      cwd: temporaryRoot,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    assertSuccess(command, "installed Windows command shim");
    if (command.stdout.trim() !== version.stdout.trim()) {
      throw new Error("installed Windows command shim returned a different version");
    }
  }

  const completedMigrationPlan = run(["--target", skillsRoot, "--bin-dir", binRoot, "--json"]);
  assertSuccess(completedMigrationPlan, "completed config-location migration plan");
  if (JSON.parse(completedMigrationPlan.stdout).configLocationMigration?.status !== "completed") {
    throw new Error("completed config-location migration was not recognized by its receipt");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, recovered: true, version: version.stdout.trim() })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
