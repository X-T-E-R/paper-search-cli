#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  computeBuildInputDigest,
  readPackageMetadata,
  sha256File,
} from "./lib/build-inputs.mjs";
import { replaceDirectoryWithPrevious } from "./lib/dist-swap.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = path.join(repoRoot, ".paper-search-runtime");
const outputRoot = path.join(runtimeRoot, `build-${randomUUID()}`);
const distPath = path.join(repoRoot, "dist");
const previousDistPath = path.join(repoRoot, "dist.previous");
const launcherProtocol = 1;

function runNode(args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${process.execPath} ${args.join(" ")} failed with exit code ${result.status}`);
  }
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

async function sourceIdentity() {
  const commit =
    process.env.PAPER_SEARCH_SOURCE_COMMIT?.trim() || gitOutput(["rev-parse", "HEAD"]);
  const dirtyFromEnv = process.env.PAPER_SEARCH_SOURCE_DIRTY;
  const dirty =
    dirtyFromEnv === "1" ||
    (dirtyFromEnv !== "0" &&
      gitOutput(["status", "--porcelain", "--untracked-files=all"]).length > 0);
  return { commit, dirty };
}

async function main() {
  const { packageJson, buildInputs } = await readPackageMetadata(repoRoot);
  const packageVersion = String(packageJson.version ?? "").trim();
  if (!packageVersion) throw new Error("package.json version is missing");

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  try {
    const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    runNode([tscPath, "-p", "tsconfig.build.json", "--outDir", outputRoot]);

    const bundleResult = await esbuild.build({
      entryPoints: [path.join(repoRoot, "src", "cli.ts")],
      outfile: path.join(outputRoot, "cli.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: true,
      legalComments: "none",
      packages: "bundle",
      metafile: true,
      define: {
        __PAPER_SEARCH_VERSION__: JSON.stringify(packageVersion),
      },
      banner: {
        js: 'import { createRequire as __paperSearchCreateRequire } from "node:module"; const require = __paperSearchCreateRequire(import.meta.url);',
      },
      logLevel: "warning",
    });
    const externalImports = Object.values(bundleResult.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external && !isBuiltin(entry.path))
      .map((entry) => entry.path);
    if (externalImports.length > 0) {
      throw new Error(`Runtime bundle retained non-built-in imports: ${[...new Set(externalImports)].join(", ")}`);
    }
    await chmod(path.join(outputRoot, "cli.js"), 0o755);
    await copyFile(
      path.join(repoRoot, "src", "external-search", "adapter-host.mjs"),
      path.join(outputRoot, "adapter-host.mjs"),
    );
    await copyFile(
      path.join(repoRoot, "src", "material", "pymupdf4llm", "pymupdf4llm-adapter.py"),
      path.join(outputRoot, "pymupdf4llm-adapter.py"),
    );
    await copyFile(
      path.join(repoRoot, "src", "material", "pymupdf4llm", "requirements.lock.txt"),
      path.join(outputRoot, "requirements.lock.txt"),
    );
    await copyFile(
      path.join(repoRoot, "src", "institutional", "instsci-adapter.py"),
      path.join(outputRoot, "instsci-adapter.py"),
    );

    const digest = process.env.PAPER_SEARCH_BUILD_INPUT_DIGEST
      ? {
          algorithm: "sha256",
          schemaVersion: 1,
          value: process.env.PAPER_SEARCH_BUILD_INPUT_DIGEST,
          fileCount: Number.parseInt(process.env.PAPER_SEARCH_BUILD_INPUT_COUNT ?? "0", 10),
        }
      : await computeBuildInputDigest(repoRoot, buildInputs);
    const build = {
      schemaVersion: 1,
      packageVersion,
      source: await sourceIdentity(),
      lockfileSha256: await sha256File(path.join(repoRoot, "package-lock.json")),
      nodeVersion: process.version,
      packageManager: packageJson.packageManager ?? null,
      builtAt: new Date().toISOString(),
      launcherProtocol,
      cliSha256: await sha256File(path.join(outputRoot, "cli.js")),
      buildInputDigest: digest,
    };
    await writeFile(path.join(outputRoot, "build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");

    const probeRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-bundle-probe-"));
    try {
      const probeCli = path.join(probeRoot, "cli.js");
      await copyFile(path.join(outputRoot, "cli.js"), probeCli);
      for (const args of [["--version"], ["--help"]]) {
        const probe = spawnSync(process.execPath, [probeCli, ...args], {
          cwd: probeRoot,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "" },
          windowsHide: true,
        });
        if (probe.error) throw probe.error;
        if (
          probe.status !== 0 ||
          (args[0] === "--version" && probe.stdout.trim() !== packageVersion)
        ) {
          throw new Error(
            `Built CLI probe ${args.join(" ")} failed (exit ${probe.status}): ${probe.stderr || probe.stdout}`,
          );
        }
      }
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }

    await replaceDirectoryWithPrevious({
      nextPath: outputRoot,
      currentPath: distPath,
      previousPath: previousDistPath,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, distPath, packageVersion, buildInputDigest: digest.value })}\n`,
    );
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
