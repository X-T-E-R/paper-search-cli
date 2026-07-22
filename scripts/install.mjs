#!/usr/bin/env node
// Assay-style source-linked installer with plan-first writes and owned recovery.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeBuildInputDigest,
  listBuildInputFiles,
  readPackageMetadata,
  sha256File,
} from "./lib/build-inputs.mjs";
import { replaceDirectoryWithPrevious } from "./lib/dist-swap.mjs";
import {
  acquireOwnedFileLock,
  assertOwnedFileLock,
} from "./lib/owned-file-lock.mjs";
import { stageMaterialProviderVerificationArtifacts } from "./lib/material-provider-verification.mjs";

const repoRoot = path.dirname(path.dirname(await realpath(fileURLToPath(import.meta.url))));
const skillSource = path.join(repoRoot, "skills", "paper-search-cli");
const launcherPath = path.join(skillSource, "scripts", "paper-search.mjs");
const runtimeRoot = path.join(repoRoot, ".paper-search-runtime");
const repoLockPath = path.join(runtimeRoot, "locks", "repo.lock");
const launcherProtocol = 1;
const lockWaitMs = 30_000;

const HELP = `Paper Search source-linked installer

Usage:
  node scripts/install.mjs [--target <skills-dir>]... [--bin-dir <dir>]
                           [--apply] [--json]

Writes are disabled by default. Without --target the skill is projected to
~/.agents/skills. Use repeated --target flags for multiple agent skill roots.

  --target <dir>          skills root (repeatable)
  --bin-dir <dir>         human CLI shim directory
  --apply                 execute the displayed plan
  --dry-run               explicit alias for the default planning mode
  --json                  emit the plan/result as JSON
`;

function parseArgs(argv) {
  const options = {
    targets: [],
    apply: false,
    json: false,
    help: false,
    selfUpdateCandidate: undefined,
    selfUpdateCommit: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires a directory");
      options.targets.push(path.resolve(value));
    } else if (argument === "--bin-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--bin-dir requires a directory");
      options.binDir = path.resolve(value);
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--self-update-candidate") {
      const value = argv[++index];
      if (!value) throw new Error("--self-update-candidate requires a directory");
      options.selfUpdateCandidate = path.resolve(value);
    } else if (argument === "--self-update-commit") {
      const value = argv[++index];
      if (!value || !/^[a-f0-9]{40,64}$/u.test(value)) {
        throw new Error("--self-update-commit requires a full commit object id");
      }
      options.selfUpdateCommit = value;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.apply && options.dryRun) {
    throw new Error("--apply and --dry-run cannot be combined");
  }
  if (Boolean(options.selfUpdateCandidate) !== Boolean(options.selfUpdateCommit)) {
    throw new Error("--self-update-candidate and --self-update-commit must be provided together");
  }
  if (options.selfUpdateCandidate && !options.apply) {
    throw new Error("The internal self-update candidate selector requires --apply");
  }
  if (options.targets.length === 0 && !options.selfUpdateCandidate) {
    options.targets.push(path.join(os.homedir(), ".agents", "skills"));
  }
  options.targets = options.targets
    .map((entry) => path.resolve(entry))
    .filter((entry, index, entries) => entries.findIndex((candidate) => samePath(candidate, entry)) === index);
  return options;
}

function resolvePaperSearchHome(env = process.env) {
  const explicit = env.PAPER_SEARCH_HOME?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("PAPER_SEARCH_HOME must be an absolute path");
    return path.normalize(explicit);
  }
  if (env.PAPER_SEARCH_INSTALL_TEST_MODE === "1" && env.PAPER_SEARCH_TEST_DATA_ROOT?.trim()) {
    return path.resolve(env.PAPER_SEARCH_TEST_DATA_ROOT);
  }
  return path.join(os.homedir(), ".paper-search");
}

function resolveDefaultBinRoot(env = process.env) {
  return path.join(resolvePaperSearchHome(env), "bin");
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

const legacyConfigRootFiles = [
  "config.toml",
  "subscriptions.toml",
  "credentials.toml",
  "external-search.toml",
];

async function inspectInstallerLegacyConfigRoot(root, origins) {
  const files = [];
  const blockers = [];
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { root, origins, nonEmpty: true, fingerprint: null, files, blockers: [`${root}: legacy root is not a real directory`] };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { root, origins, nonEmpty: false, fingerprint: null, files, blockers };
    throw error;
  }

  const inspectFile = async (relativePath) => {
    const filePath = path.join(root, relativePath);
    try {
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        blockers.push(`${filePath}: migration source must be a regular file and cannot be a symlink`);
        return;
      }
      const bytes = await readFile(filePath);
      files.push({
        relativePath: relativePath.split(path.sep).join("/"),
        path: filePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        credential: relativePath === "credentials.toml",
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  for (const name of legacyConfigRootFiles) await inspectFile(name);
  for (const directoryName of ["config.d", "adapters"]) {
    const directory = path.join(root, directoryName);
    let entries;
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        blockers.push(`${directory}: migration source must be a real directory and cannot be a symlink`);
        continue;
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const accepted = directoryName === "config.d" ? entry.name.endsWith(".toml") : entry.name.endsWith(".mjs");
      if (entry.isSymbolicLink() || !entry.isFile()) {
        blockers.push(`${path.join(directory, entry.name)}: nested directories and symlinks are not accepted`);
      } else if (accepted) {
        await inspectFile(path.join(directoryName, entry.name));
      } else if (/\.(?:bat|cmd|com|dll|exe|js|cjs|mjs|ps1|sh)$/iu.test(entry.name)) {
        blockers.push(`${path.join(directory, entry.name)}: unknown executable file is not eligible for migration`);
      }
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const fingerprint = files.length
    ? sha256Text(files.map((file) => `${file.relativePath}\0${file.sha256}`).join("\n"))
    : null;
  return { root, origins, nonEmpty: files.length > 0 || blockers.length > 0, fingerprint, files, blockers };
}

async function inspectInstallerConfigLocationMigration(home) {
  const roots = [
    ...(process.env.APPDATA ? [{ root: path.join(process.env.APPDATA, "paper-search"), origin: "windows-appdata" }] : []),
    ...(process.env.XDG_CONFIG_HOME ? [{ root: path.join(process.env.XDG_CONFIG_HOME, "paper-search"), origin: "xdg" }] : []),
    { root: path.join(os.homedir(), ".config", "paper-search"), origin: "home-config" },
  ];
  const unique = new Map();
  for (const candidate of roots) {
    if (samePath(candidate.root, home)) continue;
    const key = process.platform === "win32" ? path.resolve(candidate.root).toLowerCase() : path.resolve(candidate.root);
    const current = unique.get(key);
    if (current) current.origins.push(candidate.origin);
    else unique.set(key, { root: path.resolve(candidate.root), origins: [candidate.origin] });
  }
  const candidates = await Promise.all([...unique.values()].map((candidate) => inspectInstallerLegacyConfigRoot(candidate.root, candidate.origins)));
  const nonEmpty = candidates.filter((candidate) => candidate.nonEmpty);
  const destinationBundlePresent = await Promise.all(
    [...legacyConfigRootFiles, "config.d", "adapters"].map((name) => pathExists(path.join(home, name))),
  ).then((values) => values.some(Boolean));
  const receiptPath = path.join(home, "state", "migrations", "config-location-v1.json");
  let receiptPresent = false;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receiptPresent = receipt?.schemaVersion === 1 && receipt?.status === "complete";
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const fingerprints = new Set(nonEmpty.map((candidate) => candidate.fingerprint ?? `blocked:${candidate.root}`));
  const requiresExplicitSource = nonEmpty.length > 1 && fingerprints.size > 1;
  const selected = requiresExplicitSource ? null : nonEmpty[0] ?? null;
  const entries = [];
  // A known destination entry can be the first durable write of an
  // interrupted migration.  It is not evidence that the bundle is complete.
  if (selected) {
    for (const file of selected.files) {
      const destination = path.join(home, ...file.relativePath.split("/"));
      let destinationSha256;
      try {
        destinationSha256 = createHash("sha256").update(await readFile(destination)).digest("hex");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      entries.push({
        ...file,
        destination,
        action: !destinationSha256 ? "copy" : destinationSha256 === file.sha256 ? "identical" : "conflict",
      });
    }
  }
  const blockers = [...(selected?.blockers ?? [])];
  if (requiresExplicitSource) blockers.push("Multiple different legacy config roots require explicit migration before installer apply");
  blockers.push(...entries.filter((entry) => entry.action === "conflict").map((entry) => `Destination conflict: ${entry.destination}`));
  const status = requiresExplicitSource
    ? "ambiguous"
    : !selected ? "none"
      : blockers.length ? entries.some((entry) => entry.action === "conflict") ? "conflicted" : "blocked"
        : entries.every((entry) => entry.action === "identical") && receiptPresent ? "completed"
          : "pending";
  return { status, home, selectedSource: selected?.root ?? null, candidates, entries, blockers, receiptPath };
}

async function applyInstallerConfigLocationMigration(plan) {
  const pendingPath = path.join(path.dirname(plan.receiptPath), "config-location-v1.pending.json");
  let journal = await readJsonIfPresent(pendingPath);
  if (plan.status === "completed") {
    // Receipt persistence can succeed immediately before a process stops.
    // The receipt is authoritative only after all journalled entries completed.
    if (journal) await rm(pendingPath, { force: true });
    return false;
  }
  if (plan.status !== "pending") return false;

  const expectedEntries = plan.entries.map((entry) => ({
    relativePath: entry.relativePath,
    path: entry.path,
    destination: entry.destination,
    sha256: entry.sha256,
    credential: entry.credential,
  }));
  if (journal) {
    if (
      journal.schemaVersion !== 1 ||
      journal.status !== "pending" ||
      typeof journal.operationId !== "string" ||
      typeof journal.sourceRoot !== "string" ||
      typeof journal.destinationRoot !== "string" ||
      !samePath(journal.sourceRoot, plan.selectedSource) ||
      !samePath(journal.destinationRoot, plan.home) ||
      !Array.isArray(journal.entries) ||
      journal.entries.length !== expectedEntries.length ||
      journal.entries.some((entry, index) => {
        const expected = expectedEntries[index];
        return !expected || entry.relativePath !== expected.relativePath || entry.path !== expected.path ||
          entry.destination !== expected.destination || entry.sha256 !== expected.sha256 ||
          entry.credential !== expected.credential || !["copy", "identical"].includes(entry.action) ||
          typeof entry.completed !== "boolean";
      })
    ) {
      throw new Error(`Unsupported or unsafe config-location migration journal: ${pendingPath}`);
    }
  } else {
    journal = {
      schemaVersion: 1,
      status: "pending",
      operationId: randomUUID(),
      sourceRoot: plan.selectedSource,
      destinationRoot: plan.home,
      createdAt: new Date().toISOString(),
      entries: expectedEntries.map((entry, index) => ({
        ...entry,
        action: plan.entries[index].action,
        completed: false,
      })),
    };
    await atomicWriteJson(pendingPath, journal, 0o600);
  }

  for (const entry of journal.entries) {
    const source = await readFile(entry.path);
    if (createHash("sha256").update(source).digest("hex") !== entry.sha256) {
      throw new Error(`Legacy config source changed after planning: ${entry.path}`);
    }
    let destinationSha256;
    try {
      destinationSha256 = createHash("sha256").update(await readFile(entry.destination)).digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (entry.completed) {
      if (destinationSha256 !== entry.sha256) {
        throw new Error(`Completed config-location migration entry diverged: ${entry.destination}`);
      }
      continue;
    }
    if (destinationSha256 && destinationSha256 !== entry.sha256) {
      throw new Error(`Legacy config destination changed after planning: ${entry.destination}`);
    }
    if (!destinationSha256) {
      await mkdir(path.dirname(entry.destination), { recursive: true, mode: 0o700 });
      const temporary = `${entry.destination}.migration-${randomUUID()}.tmp`;
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await rename(temporary, entry.destination);
      if (entry.credential && process.platform !== "win32") await chmod(entry.destination, 0o600);
    }
    entry.completed = true;
    journal.updatedAt = new Date().toISOString();
    await atomicWriteJson(pendingPath, journal, 0o600);
    if (
      process.env.PAPER_SEARCH_INSTALL_TEST_MODE === "1" &&
      process.env.PAPER_SEARCH_TEST_FAIL_AFTER === `config-location:${entry.relativePath}`
    ) {
      throw new Error(`Injected config-location migration interruption after ${entry.relativePath}`);
    }
  }
  if (await pathExists(plan.receiptPath)) {
    throw new Error(`Config-location migration receipt appeared during apply: ${plan.receiptPath}`);
  }
  await mkdir(path.dirname(plan.receiptPath), { recursive: true, mode: 0o700 });
  await atomicWriteJson(plan.receiptPath, {
    schemaVersion: 1,
    status: "complete",
    sourceRoot: plan.selectedSource,
    destinationRoot: plan.home,
    operationId: journal.operationId,
    copied: journal.entries.filter((entry) => entry.action === "copy").map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256 })),
    identical: journal.entries.filter((entry) => entry.action === "identical").map((entry) => entry.relativePath),
    completedAt: new Date().toISOString(),
  }, 0o600);
  await rm(pendingPath, { force: true });
  return true;
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
}

async function readJsonWithPrevious(filePath) {
  const current = await readJsonIfPresent(filePath);
  if (current !== null) return current;
  return readJsonIfPresent(`${filePath}.previous`);
}

function validateInstallState(value, filePath) {
  if (value === null) return null;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.checkoutRealpath !== "string" ||
    !Array.isArray(value.projections) ||
    !Array.isArray(value.shims)
  ) {
    throw new Error(`Unsupported or corrupt install state: ${filePath}`);
  }
  return value;
}

function validateSetupJournal(value, filePath) {
  if (value === null) return null;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.transactionId !== "string" ||
    typeof value.planDigest !== "string" ||
    !value.plan ||
    !value.build ||
    !Array.isArray(value.operations)
  ) {
    throw new Error(`Unsupported or corrupt setup journal: ${filePath}`);
  }
  return value;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function recoverInterruptedFile(filePath) {
  const previousPath = `${filePath}.previous`;
  const [hasCurrent, hasPrevious] = await Promise.all([
    pathExists(filePath),
    pathExists(previousPath),
  ]);
  if (!hasCurrent && hasPrevious) {
    await rename(previousPath, filePath);
    return "restored-previous";
  }
  if (hasCurrent && hasPrevious) {
    await rm(previousPath, { force: true });
    return "removed-stale-previous";
  }
  return null;
}

async function atomicWriteFile(filePath, contents, mode) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const backupPath = `${filePath}.previous`;
  let movedCurrent = false;
  try {
    await recoverInterruptedFile(filePath);
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", ...(mode ? { mode } : {}) });
    await rm(backupPath, { force: true });
    try {
      await rename(filePath, backupPath);
      movedCurrent = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (movedCurrent) {
        try {
          await rename(backupPath, filePath);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Cannot install or restore ${filePath}`);
        }
      }
      throw error;
    }
    if (movedCurrent) await rm(backupPath, { force: true });
    if (mode) await chmod(filePath, mode);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function atomicWriteJson(filePath, value, mode) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function acquireLock(lockPath, timeoutMs = lockWaitMs, command = "installer setup") {
  const lock = await acquireOwnedFileLock(lockPath, { timeoutMs, command });
  return () => lock.release();
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `: ${result.stderr || result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
  }
  return result;
}

async function copyInputs(destinationRoot, inputs) {
  const files = await listBuildInputFiles(repoRoot, inputs);
  for (const file of files) {
    const destination = path.join(destinationRoot, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    if (file.symbolicLink) {
      await symlink(await readlink(file.absolutePath), destination);
    } else {
      await copyFile(file.absolutePath, destination);
      const stat = await lstat(file.absolutePath);
      await chmod(destination, stat.mode);
    }
  }
}

function verifyRuntimePreconditions(packageJson) {
  const requiredNodeMajor = Number.parseInt(String(packageJson.engines?.node ?? "").match(/\d+/u)?.[0] ?? "0", 10);
  const actualNodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!requiredNodeMajor || actualNodeMajor < requiredNodeMajor) {
    throw new Error(`Node ${packageJson.engines?.node ?? "requirement missing"} is required; found ${process.version}`);
  }
  const packageManager = String(packageJson.packageManager ?? "");
  if (!/^npm@\d+\.\d+\.\d+(?:[-+].+)?$/u.test(packageManager)) {
    throw new Error("package.json must declare packageManager as an exact npm@<version>");
  }
  const npmEngine = String(packageJson.engines?.npm ?? "");
  const minimumNpmMajor = Number.parseInt(npmEngine.match(/^>=(\d+)(?:\.|$)/u)?.[1] ?? "0", 10);
  if (!minimumNpmMajor) {
    throw new Error("package.json must declare the minimum supported npm major in engines.npm");
  }
  const npmCliPath =
    process.env.npm_execpath?.trim() ||
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmInvocation = process.platform === "win32"
    ? { command: process.execPath, argsPrefix: [npmCliPath] }
    : { command: "npm", argsPrefix: [] };
  if (process.platform === "win32" && !existsSync(npmCliPath)) {
    throw new Error(`Cannot locate npm CLI beside Node: ${npmCliPath}`);
  }
  const npmVersion = commandResult(
    npmInvocation.command,
    [...npmInvocation.argsPrefix, "--version"],
    { capture: true },
  ).stdout.trim();
  const actualNpmMajor = Number.parseInt(npmVersion.split(".")[0], 10);
  if (actualNpmMajor < minimumNpmMajor) {
    throw new Error(`npm ${npmEngine} is required (${packageManager} is the tested release); found ${npmVersion}`);
  }
  return npmInvocation;
}

async function verifyBuild(buildPath, expectedDigest, expectedLockHash) {
  const build = await readJsonIfPresent(buildPath);
  if (!build || build.schemaVersion !== 1) throw new Error(`Missing verified build identity: ${buildPath}`);
  if (build.launcherProtocol !== launcherProtocol) {
    throw new Error(`Build launcher protocol ${String(build.launcherProtocol)} is not supported`);
  }
  if (build.buildInputDigest?.value !== expectedDigest) {
    throw new Error("Existing build is stale for the current declared build inputs");
  }
  if (build.lockfileSha256 !== expectedLockHash) {
    throw new Error("Existing build does not match the current package-lock.json");
  }
  return build;
}

async function buildInIsolation({
  buildInputs,
  selfUpdateVerificationInputs,
  selfUpdateStagingInputs,
  digest,
  verificationDigest,
  lockHash,
  npmInvocation,
  quiet = false,
}) {
  const transactionPath = path.join(runtimeRoot, "staging", randomUUID());
  const sourcePath = path.join(transactionPath, "source");
  const nextDistPath = path.join(runtimeRoot, `dist-next-${randomUUID()}`);
  await mkdir(sourcePath, { recursive: true });
  try {
    await copyInputs(sourcePath, selfUpdateStagingInputs);
    const commit = gitOutput(["rev-parse", "HEAD"]);
    const dirty = gitOutput(["status", "--porcelain", "--untracked-files=all"]).length > 0;
    const buildEnv = {
      ...process.env,
      PAPER_SEARCH_SOURCE_COMMIT: commit,
      PAPER_SEARCH_SOURCE_DIRTY: dirty ? "1" : "0",
      PAPER_SEARCH_BUILD_INPUT_DIGEST: digest.value,
      PAPER_SEARCH_BUILD_INPUT_COUNT: String(digest.fileCount),
    };
    commandResult(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, "ci", "--no-audit", "--no-fund"],
      { cwd: sourcePath, env: buildEnv, capture: quiet },
    );
    commandResult(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, "run", "build"],
      { cwd: sourcePath, env: buildEnv, capture: quiet },
    );
    await stageMaterialProviderVerificationArtifacts({
      cliRepoRoot: repoRoot,
      stagedSourcePath: sourcePath,
      env: buildEnv,
      buildDistributions: async (providerRoot) => {
        commandResult(
          npmInvocation.command,
          [...npmInvocation.argsPrefix, "ci", "--no-audit", "--no-fund"],
          { cwd: providerRoot, env: buildEnv, capture: quiet },
        );
        commandResult(
          npmInvocation.command,
          [...npmInvocation.argsPrefix, "run", "build"],
          { cwd: providerRoot, env: buildEnv, capture: quiet },
        );
      },
    });
    // The retained checkout proves its own source in isolation against the
    // freshly built provider artifacts. Heavier cross-repository distribution
    // suites remain in the release gate.
    commandResult(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, "run", "test:self-update-target"],
      { cwd: sourcePath, env: buildEnv, capture: quiet },
    );
    const stagedMetadata = await readPackageMetadata(sourcePath);
    if (
      JSON.stringify(stagedMetadata.buildInputs) !== JSON.stringify(buildInputs) ||
      JSON.stringify(stagedMetadata.selfUpdateVerificationInputs) !==
        JSON.stringify(selfUpdateVerificationInputs)
    ) {
      throw new Error("Isolated staging changed the declared runtime or self-update verification input lists");
    }
    const stagedDigest = await computeBuildInputDigest(sourcePath, stagedMetadata.buildInputs);
    if (stagedDigest.value !== digest.value) {
      throw new Error("Isolated staging no longer matches the declared runtime build inputs");
    }
    const stagedVerificationDigest = await computeBuildInputDigest(
      sourcePath,
      stagedMetadata.selfUpdateVerificationInputs,
    );
    if (stagedVerificationDigest.value !== verificationDigest.value) {
      throw new Error("Isolated staging no longer matches the self-update verification inputs");
    }
    const build = await verifyBuild(path.join(sourcePath, "dist", "build.json"), digest.value, lockHash);
    commandResult(process.execPath, [path.join(sourcePath, "dist", "cli.js"), "--help"], {
      cwd: transactionPath,
      env: { ...process.env, NODE_PATH: "" },
      capture: true,
    });
    const currentMetadata = await readPackageMetadata(repoRoot);
    if (
      JSON.stringify(currentMetadata.buildInputs) !== JSON.stringify(buildInputs) ||
      JSON.stringify(currentMetadata.selfUpdateVerificationInputs) !==
        JSON.stringify(selfUpdateVerificationInputs)
    ) {
      throw new Error("Declared runtime or self-update verification input lists changed during the isolated build");
    }
    const currentDigest = await computeBuildInputDigest(repoRoot, currentMetadata.buildInputs);
    if (currentDigest.value !== digest.value) {
      throw new Error("Declared build inputs changed during the isolated build; candidate discarded");
    }
    const currentVerificationDigest = await computeBuildInputDigest(
      repoRoot,
      currentMetadata.selfUpdateVerificationInputs,
    );
    if (currentVerificationDigest.value !== verificationDigest.value) {
      throw new Error("Self-update verification inputs changed during the isolated build; candidate discarded");
    }
    await rename(path.join(sourcePath, "dist"), nextDistPath);
    await replaceDirectoryWithPrevious({
      nextPath: nextDistPath,
      currentPath: path.join(repoRoot, "dist"),
      previousPath: path.join(repoRoot, "dist.previous"),
    });
    return build;
  } finally {
    await rm(transactionPath, { recursive: true, force: true }).catch(() => {});
    await rm(nextDistPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function selectPreverifiedSelfUpdateCandidate({
  candidatePath,
  expectedCommit,
  buildInputs,
  selfUpdateVerificationInputs,
  digest,
  verificationDigest,
  lockHash,
}) {
  const candidateBuildPath = path.join(candidatePath, "build.json");
  const build = await verifyBuild(candidateBuildPath, digest.value, lockHash);
  if (
    build.source?.commit !== expectedCommit ||
    build.source?.dirty !== false
  ) {
    throw new Error(
      `Self-update candidate source identity must be clean commit ${expectedCommit}`,
    );
  }
  if (typeof build.cliSha256 !== "string") {
    throw new Error("Self-update candidate does not declare its CLI SHA-256");
  }
  const candidateCliPath = path.join(candidatePath, "cli.js");
  if ((await sha256File(candidateCliPath)) !== build.cliSha256) {
    throw new Error("Self-update candidate CLI hash does not match build.json");
  }
  commandResult(process.execPath, [candidateCliPath, "--help"], {
    cwd: path.dirname(candidatePath),
    env: { ...process.env, NODE_PATH: "" },
    capture: true,
  });
  const currentMetadata = await readPackageMetadata(repoRoot);
  if (
    JSON.stringify(currentMetadata.buildInputs) !== JSON.stringify(buildInputs) ||
    JSON.stringify(currentMetadata.selfUpdateVerificationInputs) !==
      JSON.stringify(selfUpdateVerificationInputs)
  ) {
    throw new Error("Declared runtime or self-update verification input lists changed while selecting the candidate");
  }
  const currentDigest = await computeBuildInputDigest(repoRoot, currentMetadata.buildInputs);
  if (currentDigest.value !== digest.value) {
    throw new Error("Declared build inputs changed while selecting the self-update candidate");
  }
  const currentVerificationDigest = await computeBuildInputDigest(
    repoRoot,
    currentMetadata.selfUpdateVerificationInputs,
  );
  if (currentVerificationDigest.value !== verificationDigest.value) {
    throw new Error("Self-update verification inputs changed while selecting the self-update candidate");
  }

  const nextDistPath = path.join(runtimeRoot, `dist-next-${randomUUID()}`);
  try {
    await cp(candidatePath, nextDistPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    if ((await sha256File(path.join(nextDistPath, "cli.js"))) !== build.cliSha256) {
      throw new Error("Copied self-update candidate CLI failed integrity verification");
    }
    await replaceDirectoryWithPrevious({
      nextPath: nextDistPath,
      currentPath: path.join(repoRoot, "dist"),
      previousPath: path.join(repoRoot, "dist.previous"),
    });
    return build;
  } finally {
    await rm(nextDistPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inspectLink(destination, intendedTarget, installState) {
  const recorded = installState?.projections?.find((entry) => samePath(entry.path, destination));
  let stat;
  try {
    stat = await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return { action: "create", destination, intendedTarget, recorded };
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return { action: "conflict", destination, intendedTarget, reason: "destination is not a link" };
  }
  try {
    const actualTarget = await realpath(destination);
    if (samePath(actualTarget, intendedTarget)) {
      return { action: recorded ? "keep" : "adopt", destination, intendedTarget, actualTarget };
    }
    return {
      action: "conflict",
      destination,
      intendedTarget,
      actualTarget,
      reason: recorded ? "recorded link target diverged" : "unmanaged link target",
    };
  } catch {
    return {
      action: "conflict",
      destination,
      intendedTarget,
      reason: recorded ? "recorded link is broken" : "unmanaged broken link",
    };
  }
}

function expectedShims(binRoot) {
  const marker = "paper-search managed shim v1";
  const bridgePath = path.join(binRoot, "paper-search.mjs");
  const bridge = {
    path: bridgePath,
    mode: 0o755,
    contents: `#!/usr/bin/env node\n// ${marker}\nimport { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(
      launcherPath,
    )}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env, cwd: process.cwd(), windowsHide: true });\nchild.on("error", (error) => { console.error(error.message); process.exitCode = 1; });\nchild.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });\n`,
  };
  if (process.platform === "win32") {
    const commandPath = path.join(binRoot, "paper-search.cmd");
    const powershellPath = path.join(binRoot, "paper-search.ps1");
    return [
      bridge,
      {
        path: commandPath,
        mode: undefined,
        contents: `@echo off\r\nREM ${marker}\r\nnode "%~dp0paper-search.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      },
      {
        path: powershellPath,
        mode: undefined,
        contents: `# ${marker}\r\n& node (Join-Path $PSScriptRoot "paper-search.mjs") @args\r\nexit $LASTEXITCODE\r\n`,
      },
    ];
  }
  return [
    bridge,
    {
      path: path.join(binRoot, "paper-search"),
      mode: 0o755,
      contents: `#!/bin/sh\n# ${marker}\nexec node "$(dirname "$0")/paper-search.mjs" "$@"\n`,
    },
  ];
}

async function inspectShim(shim, installState) {
  const expectedHash = sha256Text(shim.contents);
  const recorded = installState?.shims?.find((entry) => samePath(entry.path, shim.path));
  try {
    const stat = await lstat(shim.path);
    if (!stat.isFile()) {
      return { action: "conflict", ...shim, expectedHash, reason: "destination is not a file" };
    }
    const currentHash = sha256Text(await readFile(shim.path, "utf8"));
    if (currentHash === expectedHash) {
      return { action: recorded ? "keep" : "adopt", ...shim, expectedHash, currentHash };
    }
    if (recorded?.sha256 === currentHash) {
      return { action: "repair", ...shim, expectedHash, currentHash };
    }
    return { action: "conflict", ...shim, expectedHash, currentHash, reason: "unmanaged or modified shim" };
  } catch (error) {
    if (error?.code === "ENOENT") return { action: "create", ...shim, expectedHash };
    throw error;
  }
}

async function createPlan(
  options,
  installState,
  digest,
  verificationDigest,
  lockHash,
  recoveryFiles = [],
) {
  const dataRoot = resolvePaperSearchHome();
  const configRoot = dataRoot;
  const binRoot = options.binDir ?? resolveDefaultBinRoot();
  const configLocationMigration = await inspectInstallerConfigLocationMigration(configRoot);
  const binOnPath = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => samePath(entry, binRoot));
  const projections = await Promise.all(
    options.targets.map((target) =>
      inspectLink(path.join(target, "paper-search-cli"), skillSource, installState),
    ),
  );
  const shims = await Promise.all(expectedShims(binRoot).map((shim) => inspectShim(shim, installState)));
  const ownershipConflict =
    installState?.checkoutRealpath && !samePath(installState.checkoutRealpath, repoRoot)
      ? `install state belongs to ${installState.checkoutRealpath}`
      : null;
  const conflicts = [
    ...(ownershipConflict ? [ownershipConflict] : []),
    ...projections.filter((entry) => entry.action === "conflict").map((entry) => `${entry.destination}: ${entry.reason}`),
    ...shims.filter((entry) => entry.action === "conflict").map((entry) => `${entry.path}: ${entry.reason}`),
    ...(["ambiguous", "conflicted", "blocked"].includes(configLocationMigration.status)
      ? configLocationMigration.blockers
      : []),
  ];
  const planIdentity = {
    schemaVersion: 1,
    repoRoot,
    skillSource,
    targets: options.targets,
    binRoot,
    dataRoot,
    configRoot,
    configLocationMigration,
    buildInputDigest: digest.value,
    selfUpdateVerificationDigest: verificationDigest.value,
    lockfileSha256: lockHash,
    launcherProtocol,
    recoveryFiles,
    observedInstallState: installState
      ? {
          checkoutRealpath: installState.checkoutRealpath,
          launcherProtocol: installState.launcherProtocol,
          updatedAt: installState.updatedAt ?? null,
        }
      : null,
    projections: projections.map((entry) => ({
      path: entry.destination,
      desiredTarget: entry.intendedTarget,
      action: entry.action,
      actualTarget: entry.actualTarget ?? null,
      reason: entry.reason ?? null,
    })),
    shims: shims.map((entry) => ({
      path: entry.path,
      action: entry.action,
      currentHash: entry.currentHash ?? null,
      expectedHash: entry.expectedHash,
      reason: entry.reason ?? null,
    })),
  };
  return {
    ...planIdentity,
    binOnPath,
    planDigest: sha256Text(JSON.stringify(planIdentity)),
    mode: options.apply ? "apply" : "plan",
    build: options.selfUpdateCandidate
      ? "select-preverified-self-update-candidate"
      : "isolated-npm-ci-test-and-bundle",
    projections,
    shims,
    conflicts,
    blocked: conflicts.length > 0,
  };
}

function printPlan(plan, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Paper Search installer (${plan.mode})\n`);
  process.stdout.write(`  repo:       ${plan.repoRoot}\n`);
  process.stdout.write(`  configRoot: ${plan.configRoot}\n`);
  process.stdout.write(`  dataRoot:   ${plan.dataRoot}\n`);
  process.stdout.write(`  binRoot:    ${plan.binRoot}\n`);
  process.stdout.write(`  config migration: ${plan.configLocationMigration.status}\n`);
  process.stdout.write(`  bin on PATH: ${plan.binOnPath ? "yes" : "no"}\n`);
  process.stdout.write(`  build:      ${plan.build}\n`);
  for (const recovery of plan.recoveryFiles ?? []) {
    process.stdout.write(`  recover:    ${recovery}\n`);
  }
  for (const entry of plan.projections) {
    process.stdout.write(`  skill ${entry.action.padEnd(8)} ${entry.destination} -> ${entry.intendedTarget}\n`);
  }
  for (const entry of plan.shims) {
    process.stdout.write(`  shim  ${entry.action.padEnd(8)} ${entry.path}\n`);
  }
  if (plan.conflicts.length > 0) {
    process.stdout.write(`  conflicts:\n${plan.conflicts.map((entry) => `    - ${entry}`).join("\n")}\n`);
  }
  if (!plan.mode.includes("apply")) process.stdout.write("No files changed. Re-run with --apply to execute this plan.\n");
}

async function applyProjection(entry) {
  if (entry.action === "keep" || entry.action === "adopt") return;
  await mkdir(path.dirname(entry.destination), { recursive: true });
  await symlink(entry.intendedTarget, entry.destination, process.platform === "win32" ? "junction" : "dir");
}

async function applySetup(plan, existingState, build) {
  const stateRoot = path.join(plan.dataRoot, "state");
  const journalPath = path.join(stateRoot, "setup-journal.json");
  const installPath = path.join(stateRoot, "install.json");
  const operationEntries = [
    ...plan.projections.map((entry) => ({ id: `projection:${entry.destination}`, kind: "projection", path: entry.destination })),
    ...plan.shims.map((entry) => ({ id: `shim:${entry.path}`, kind: "shim", path: entry.path })),
    { id: "install-state", kind: "state", path: installPath },
  ];
  let journal = await readJsonIfPresent(journalPath);
  if (journal && (journal.schemaVersion !== 1 || !journal.plan || !journal.build)) {
    throw new Error(`Unsupported or incomplete setup journal: ${journalPath}`);
  }
  if (journal && journal.planDigest !== plan.planDigest) {
    throw new Error(`Unfinished setup journal belongs to a different plan: ${journalPath}`);
  }
  if (!journal) {
    journal = {
      schemaVersion: 1,
      transactionId: randomUUID(),
      ownerToken: randomUUID(),
      planDigest: plan.planDigest,
      checkoutRealpath: repoRoot,
      createdAt: new Date().toISOString(),
      plan,
      build,
      operations: operationEntries.map((entry) => ({ ...entry, status: "pending" })),
    };
    await atomicWriteJson(journalPath, journal);
  }

  const markDone = async (id) => {
    const operation = journal.operations.find((entry) => entry.id === id);
    if (operation) operation.status = "done";
    journal.updatedAt = new Date().toISOString();
    await atomicWriteJson(journalPath, journal);
    if (
      process.env.PAPER_SEARCH_INSTALL_TEST_MODE === "1" &&
      process.env.PAPER_SEARCH_TEST_FAIL_AFTER === id
    ) {
      throw new Error(`Injected setup interruption after ${id}`);
    }
  };

  for (const entry of plan.projections) {
    const id = `projection:${entry.destination}`;
    const current = await inspectLink(entry.destination, entry.intendedTarget, existingState);
    if (current.action === "conflict") throw new Error(`${entry.destination}: ${current.reason}`);
    if (journal.operations.find((operation) => operation.id === id)?.status === "done") {
      if (current.action !== "keep" && current.action !== "adopt") {
        throw new Error(`Completed projection diverged during recovery: ${entry.destination}`);
      }
      continue;
    }
    await applyProjection(current);
    await markDone(id);
  }
  for (const entry of plan.shims) {
    const id = `shim:${entry.path}`;
    await recoverInterruptedFile(entry.path);
    const current = await inspectShim(entry, existingState);
    if (current.action === "conflict") throw new Error(`${entry.path}: ${current.reason}`);
    if (journal.operations.find((operation) => operation.id === id)?.status === "done") {
      if (current.action !== "keep" && current.action !== "adopt") {
        throw new Error(`Completed shim diverged during recovery: ${entry.path}`);
      }
      continue;
    }
    if (current.action === "create" || current.action === "repair") {
      await atomicWriteFile(entry.path, entry.contents, entry.mode);
    }
    await markDone(id);
  }

  if (journal.operations.find((entry) => entry.id === "install-state")?.status !== "done") {
    const projectionMap = new Map(
      (existingState?.projections ?? []).map((entry) => [path.resolve(entry.path), entry]),
    );
    for (const entry of plan.projections) {
      projectionMap.set(path.resolve(entry.destination), {
        path: path.resolve(entry.destination),
        target: skillSource,
        linkType: process.platform === "win32" ? "junction" : "symlink",
      });
    }
    const shimMap = new Map((existingState?.shims ?? []).map((entry) => [path.resolve(entry.path), entry]));
    for (const entry of plan.shims) {
      shimMap.set(path.resolve(entry.path), { path: path.resolve(entry.path), sha256: entry.expectedHash });
    }
    const state = {
      schemaVersion: 1,
      installId: existingState?.installId ?? randomUUID(),
      installedAt: existingState?.installedAt ?? new Date().toISOString(),
      checkoutRealpath: repoRoot,
      binRoot: plan.binRoot,
      sourceManagementMode: existingState?.sourceManagementMode ?? "user-managed",
      launcherProtocol,
      buildIdentity: {
        packageVersion: build.packageVersion,
        buildInputDigest: build.buildInputDigest,
        lockfileSha256: build.lockfileSha256,
        source: build.source,
        builtAt: build.builtAt,
      },
      projections: [...projectionMap.values()].sort((left, right) => left.path.localeCompare(right.path, "en")),
      shims: [...shimMap.values()].sort((left, right) => left.path.localeCompare(right.path, "en")),
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(installPath, state);
    await markDone("install-state");
  } else {
    await recoverInterruptedFile(installPath);
    const committed = validateInstallState(await readJsonIfPresent(installPath), installPath);
    if (
      !committed ||
      !samePath(committed.checkoutRealpath, repoRoot) ||
      committed.launcherProtocol !== launcherProtocol ||
      committed.buildIdentity?.buildInputDigest?.value !== build.buildInputDigest?.value
    ) {
      throw new Error(`Completed install state diverged during recovery: ${installPath}`);
    }
  }
  const operationId = journal.transactionId;
  await rm(journalPath, { force: true });
  return operationId;
}

async function appendSetupLifecycleEvent({ dataRoot, operationId, planDigest }) {
  const timestamp = new Date().toISOString();
  const month = timestamp.slice(0, 7);
  const eventPath = path.join(dataRoot, "state", "events", `${month}.jsonl`);
  const eventLockPath = path.join(dataRoot, "state", "locks", "event", `${month}.lock`);
  const releaseEvent = await acquireLock(eventLockPath, lockWaitMs, "event append");
  try {
    await mkdir(path.dirname(eventPath), { recursive: true });
    await appendFile(eventPath, `${JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      operationId,
      timestamp,
      command: "setup",
      affectedIds: [],
      outcome: "applied",
      planDigest,
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } finally {
    await releaseEvent();
  }
}

async function verifySelectedBuild(expectedBuild) {
  const buildPath = path.join(repoRoot, "dist", "build.json");
  const selected = await readJsonIfPresent(buildPath);
  if (
    !selected ||
    selected.schemaVersion !== 1 ||
    selected.launcherProtocol !== launcherProtocol ||
    selected.buildInputDigest?.value !== expectedBuild.buildInputDigest?.value ||
    selected.lockfileSha256 !== expectedBuild.lockfileSha256
  ) {
    throw new Error("Pending setup journal does not match the currently selected build");
  }
  if (expectedBuild.cliSha256) {
    const actualCliHash = await sha256File(path.join(repoRoot, "dist", "cli.js"));
    if (actualCliHash !== expectedBuild.cliSha256) {
      throw new Error("Selected CLI hash differs from the pending setup journal");
    }
  }
  return selected;
}

async function clearSatisfiedSelfUpdateRecovery(dataRoot, build) {
  const filePath = path.join(dataRoot, "state", "self-update-recovery.json");
  const recovery = await readJsonIfPresent(filePath);
  if (!recovery) return false;
  if (
    recovery.schemaVersion !== 1 ||
    typeof recovery.targetCommit !== "string" ||
    !["canonical-advanced", "post-fast-forward-failed"].includes(recovery.phase)
  ) {
    throw new Error(`Unsupported or corrupt self-update recovery state: ${filePath}`);
  }
  if (recovery.targetCommit !== build.source?.commit || build.source?.dirty !== false) {
    return false;
  }
  await rm(filePath);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const {
    packageJson,
    buildInputs,
    selfUpdateVerificationInputs,
  } = await readPackageMetadata(repoRoot);
  await lstat(skillSource);
  await lstat(launcherPath);
  const digest = await computeBuildInputDigest(repoRoot, buildInputs);
  const verificationDigest = await computeBuildInputDigest(
    repoRoot,
    selfUpdateVerificationInputs,
  );
  const lockHash = await sha256File(path.join(repoRoot, "package-lock.json"));
  const dataRoot = resolvePaperSearchHome();
  const stateRoot = path.join(dataRoot, "state");
  const installPath = path.join(stateRoot, "install.json");
  const journalPath = path.join(stateRoot, "setup-journal.json");
  const recoveryFiles = [];
  for (const filePath of [installPath, journalPath]) {
    if (await pathExists(`${filePath}.previous`)) recoveryFiles.push(filePath);
  }
  let installState = validateInstallState(await readJsonWithPrevious(installPath), installPath);
  let pendingJournal = validateSetupJournal(await readJsonWithPrevious(journalPath), journalPath);
  const npmInvocation = verifyRuntimePreconditions(packageJson);
  let plan = pendingJournal
    ? {
        ...pendingJournal.plan,
        mode: options.apply ? "recovery-apply" : "recovery-plan",
        recovery: true,
        recoveryFiles,
      }
    : await createPlan(
        options,
        installState,
        digest,
        verificationDigest,
        lockHash,
        recoveryFiles,
      );
  // Applied JSON emits one final document; npm/build progress is captured.
  if (!options.json || !options.apply) printPlan(plan, options.json);
  if (plan.blocked) throw new Error("Installer plan is blocked by unmanaged destinations");
  if (!options.apply) return;

  let releaseRepo;
  if (options.selfUpdateCandidate) {
    const inheritedToken = process.env.PAPER_SEARCH_HELD_REPO_LOCK_TOKEN;
    const owner = await assertOwnedFileLock(repoLockPath, inheritedToken);
    if (owner.pid !== process.ppid || owner.command !== "self update") {
      throw new Error("The self-update candidate selector requires the parent self-update repo lock");
    }
    releaseRepo = async () => undefined;
  } else {
    releaseRepo = await acquireLock(repoLockPath);
  }
  let releaseSetup;
  let operationId;
  let recoveredSetup = false;
  let clearedSelfUpdateRecovery = false;
  try {
    releaseSetup = await acquireLock(path.join(stateRoot, "locks", "setup.lock"));
    await recoverInterruptedFile(installPath);
    await recoverInterruptedFile(journalPath);
    installState = validateInstallState(await readJsonIfPresent(installPath), installPath);
    pendingJournal = validateSetupJournal(await readJsonIfPresent(journalPath), journalPath);

    let build;
    if (pendingJournal) {
      plan = pendingJournal.plan;
      build = await verifySelectedBuild(pendingJournal.build);
    } else {
      const lockedMetadata = await readPackageMetadata(repoRoot);
      const lockedDigest = await computeBuildInputDigest(repoRoot, lockedMetadata.buildInputs);
      const lockedVerificationDigest = await computeBuildInputDigest(
        repoRoot,
        lockedMetadata.selfUpdateVerificationInputs,
      );
      const lockedLockHash = await sha256File(path.join(repoRoot, "package-lock.json"));
      const lockedPlan = await createPlan(
        options,
        installState,
        lockedDigest,
        lockedVerificationDigest,
        lockedLockHash,
      );
      if (lockedPlan.blocked) {
        throw new Error(`Installer plan changed and is blocked: ${lockedPlan.conflicts.join("; ")}`);
      }
      if (recoveryFiles.length === 0 && lockedPlan.planDigest !== plan.planDigest) {
        throw new Error("Installer inputs or destination state changed after planning; run the plan again");
      }
      plan = lockedPlan;
      build = options.selfUpdateCandidate
        ? await selectPreverifiedSelfUpdateCandidate({
            candidatePath: options.selfUpdateCandidate,
            expectedCommit: options.selfUpdateCommit,
            buildInputs: lockedMetadata.buildInputs,
            selfUpdateVerificationInputs: lockedMetadata.selfUpdateVerificationInputs,
            digest: lockedDigest,
            verificationDigest: lockedVerificationDigest,
            lockHash: lockedLockHash,
          })
        : await buildInIsolation({
            buildInputs: lockedMetadata.buildInputs,
            selfUpdateVerificationInputs: lockedMetadata.selfUpdateVerificationInputs,
            selfUpdateStagingInputs: lockedMetadata.selfUpdateStagingInputs,
            digest: lockedDigest,
            verificationDigest: lockedVerificationDigest,
            lockHash: lockedLockHash,
            npmInvocation,
            quiet: options.json,
          });
    }
    recoveredSetup = Boolean(pendingJournal);
    // A recovered setup journal embeds the pre-interruption installer plan.
    // Re-inspect config migration state: its receipt may have been committed
    // before setup later interrupted, so replaying the stale pending plan
    // would incorrectly start a second migration journal.
    await applyInstallerConfigLocationMigration(
      await inspectInstallerConfigLocationMigration(plan.dataRoot),
    );
    operationId = await applySetup(plan, installState, build);
    if (!options.selfUpdateCandidate) {
      clearedSelfUpdateRecovery = await clearSatisfiedSelfUpdateRecovery(dataRoot, build);
    }
  } finally {
    if (releaseSetup) await releaseSetup();
    await releaseRepo();
  }
  if (!options.selfUpdateCandidate) {
    try {
      await appendSetupLifecycleEvent({ dataRoot, operationId, planDigest: plan.planDigest });
    } catch (error) {
      process.stderr.write(
        `warning: authoritative setup state was applied, but the lifecycle event could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        applied: true,
        recovered: recoveredSetup,
        selfUpdateRecoveryCleared: clearedSelfUpdateRecovery,
        plan,
      })}\n`,
    );
  } else {
    process.stdout.write(
      recoveredSetup
        ? "Paper Search interrupted setup recovered successfully.\n"
        : "Paper Search setup applied successfully.\n",
    );
  }
}

main().catch((error) => {
  process.stderr.write(`install failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
