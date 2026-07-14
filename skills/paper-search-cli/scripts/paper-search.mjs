#!/usr/bin/env node
// Source-linked Paper Search launcher. The installed skill is a Junction/symlink
// into this repository, so resolving this file's real path recovers the checkout.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_PROTOCOL = 1;
const here = path.dirname(realpathSync(fileURLToPath(import.meta.url)));

function findRepoRoot(start) {
  for (let directory = start; ; directory = path.dirname(directory)) {
    const packagePath = path.join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        if (packageJson.name === "paper-search-cli") return directory;
      } catch {
        // Keep walking. Parent package files do not own this skill.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
  }
}

const repoRoot = findRepoRoot(here);
if (!repoRoot) {
  process.stderr.write(
    "paper-search: could not locate the owning Paper Search checkout.\n" +
      "Install this skill from a retained checkout with: node scripts/install.mjs --apply\n",
  );
  process.exit(1);
}

const cliPath = path.join(repoRoot, "dist", "cli.js");
const buildPath = path.join(repoRoot, "dist", "build.json");
if (!existsSync(cliPath) || !existsSync(buildPath)) {
  process.stderr.write(
    `paper-search: verified runtime is missing under ${path.join(repoRoot, "dist")}\n` +
      `Run: node ${path.join(repoRoot, "scripts", "install.mjs")} --apply\n`,
  );
  process.exit(1);
}

let build;
try {
  build = JSON.parse(readFileSync(buildPath, "utf8"));
} catch (error) {
  process.stderr.write(`paper-search: invalid build identity at ${buildPath}: ${error.message}\n`);
  process.exit(1);
}
if (build.launcherProtocol !== LAUNCHER_PROTOCOL) {
  process.stderr.write(
    `paper-search: launcher protocol ${LAUNCHER_PROTOCOL} cannot run build protocol ${String(
      build.launcherProtocol,
    )}. Re-run the repository installer.\n`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  process.stderr.write(`paper-search: failed to start CLI: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
