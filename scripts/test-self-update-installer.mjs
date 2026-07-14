#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-self-update-installer-"));
const repoRoot = path.join(temporaryRoot, "checkout");
const candidatePath = path.join(temporaryRoot, "candidate-dist");
const dataRoot = path.join(temporaryRoot, "data");
const skillsRoot = path.join(temporaryRoot, "skills");
const binRoot = path.join(temporaryRoot, "bin");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function writeBundle(directory, version, commit, digest, lockHash) {
  await mkdir(directory, { recursive: true });
  const cli = `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log(${JSON.stringify(version)}); else console.log("fixture help");\n`;
  await writeFile(path.join(directory, "cli.js"), cli, "utf8");
  const build = {
    schemaVersion: 1,
    packageVersion: version,
    source: { commit, dirty: false },
    lockfileSha256: lockHash,
    nodeVersion: process.version,
    builtAt: "2026-07-14T00:00:00.000Z",
    launcherProtocol: 1,
    cliSha256: createHash("sha256").update(cli).digest("hex"),
    buildInputDigest: digest,
  };
  await writeFile(path.join(directory, "build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");
  return build;
}

try {
  await mkdir(repoRoot, { recursive: true });
  const sourceBuildInputs = await import(
    pathToFileURL(path.join(sourceRoot, "scripts", "lib", "build-inputs.mjs")).href
  );
  const sourceMetadata = await sourceBuildInputs.readPackageMetadata(sourceRoot);
  const runtimeFiles = new Set(
    (await sourceBuildInputs.listBuildInputFiles(sourceRoot, sourceMetadata.buildInputs))
      .map((entry) => entry.relativePath),
  );
  const stagingFiles = new Set(
    (await sourceBuildInputs.listBuildInputFiles(sourceRoot, sourceMetadata.selfUpdateStagingInputs))
      .map((entry) => entry.relativePath),
  );
  for (const verificationOnly of [
    "README.md",
    "scripts/install.mjs",
    "tests/unit/self-update.test.ts",
  ]) {
    if (runtimeFiles.has(verificationOnly) || !stagingFiles.has(verificationOnly)) {
      throw new Error(`runtime/staging input separation is invalid for ${verificationOnly}`);
    }
  }
  for (const relative of [".gitignore", ...sourceMetadata.selfUpdateStagingInputs]) {
    await mkdir(path.dirname(path.join(repoRoot, relative)), { recursive: true });
    await cp(path.join(sourceRoot, relative), path.join(repoRoot, relative), { recursive: true });
  }
  run("git", ["init", "-b", "main"]);
  run("git", ["config", "user.email", "fixture@example.test"]);
  run("git", ["config", "user.name", "Fixture"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-m", "fixture checkout"]);
  const commit = run("git", ["rev-parse", "HEAD"]);

  const buildInputs = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "lib", "build-inputs.mjs")).href
  );
  const metadata = await buildInputs.readPackageMetadata(repoRoot);
  const digest = await buildInputs.computeBuildInputDigest(repoRoot, metadata.buildInputs);
  const lockHash = await buildInputs.sha256File(path.join(repoRoot, "package-lock.json"));
  await writeBundle(path.join(repoRoot, "dist"), "old-runtime", commit, digest, lockHash);
  const candidateBuild = await writeBundle(candidatePath, "candidate-runtime", commit, digest, lockHash);

  const projectionPath = path.join(skillsRoot, "paper-search-cli");
  await mkdir(skillsRoot, { recursive: true });
  await symlink(
    path.join(repoRoot, "skills", "paper-search-cli"),
    projectionPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  const installPath = path.join(dataRoot, "state", "install.json");
  await mkdir(path.dirname(installPath), { recursive: true });
  await writeFile(
    installPath,
    `${JSON.stringify({
      schemaVersion: 1,
      installId: "fixture-install",
      checkoutRealpath: await realpath(repoRoot),
      binRoot,
      sourceManagementMode: "self-update",
      launcherProtocol: 1,
      buildIdentity: null,
      projections: [{
        path: projectionPath,
        target: path.join(repoRoot, "skills", "paper-search-cli"),
        linkType: process.platform === "win32" ? "junction" : "symlink",
      }],
      shims: [],
    }, null, 2)}\n`,
    "utf8",
  );

  const lockModule = await import(
    pathToFileURL(path.join(repoRoot, "scripts", "lib", "owned-file-lock.mjs")).href
  );
  const lock = await lockModule.acquireOwnedFileLock(
    path.join(repoRoot, ".paper-search-runtime", "locks", "repo.lock"),
    { command: "self update", timeoutMs: 2_000 },
  );
  try {
    const output = run(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "install.mjs"),
        "--target",
        skillsRoot,
        "--bin-dir",
        binRoot,
        "--apply",
        "--json",
        "--self-update-candidate",
        candidatePath,
        "--self-update-commit",
        commit,
      ],
      {
        env: {
          ...process.env,
          PAPER_SEARCH_INSTALL_TEST_MODE: "1",
          PAPER_SEARCH_TEST_DATA_ROOT: dataRoot,
          PAPER_SEARCH_HELD_REPO_LOCK_TOKEN: lock.token,
        },
      },
    );
    const result = JSON.parse(output);
    if (!result.ok || result.plan.build !== "select-preverified-self-update-candidate") {
      throw new Error("installer did not report preverified candidate selection");
    }
  } finally {
    await lock.release();
  }

  const selected = run(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "--version"]);
  const prior = run(process.execPath, [path.join(repoRoot, "dist.previous", "cli.js"), "--version"]);
  if (selected !== "candidate-runtime" || prior !== "old-runtime") {
    throw new Error("preverified candidate selection did not retain the prior runtime");
  }
  const state = JSON.parse(await readFile(path.join(dataRoot, "state", "install.json"), "utf8"));
  if (
    state.sourceManagementMode !== "self-update" ||
    state.buildIdentity?.source?.commit !== commit ||
    state.buildIdentity?.buildInputDigest?.value !== candidateBuild.buildInputDigest.value
  ) {
    throw new Error("preverified candidate selection did not update installer identity");
  }
  const eventRoot = path.join(dataRoot, "state", "events");
  const eventFiles = await readdir(eventRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (eventFiles.length !== 0) {
    throw new Error("internal candidate selection wrote a duplicate setup lifecycle event");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, selected, prior })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
