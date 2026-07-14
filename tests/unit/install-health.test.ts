import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectInstallHealth,
  type BuildIdentity,
  type InstallPaths,
  type InstallState,
} from "../../src/runtime/installLayout.js";

const tempDirs: string[] = [];

interface Fixture {
  repoRoot: string;
  paths: InstallPaths;
  build: BuildIdentity;
  install: InstallState;
}

interface DigestModule {
  readPackageMetadata(repoRoot: string): Promise<{ buildInputs: string[] }>;
  computeBuildInputDigest(
    repoRoot: string,
    buildInputs: string[],
  ): Promise<BuildIdentity["buildInputDigest"] & { fileCount: number }>;
  sha256File(filePath: string): Promise<string>;
}

afterEach(async () => {
  const fs = await import("node:fs/promises");
  await Promise.all(tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function createFixture(options: { git?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-install-health-"));
  tempDirs.push(root);
  const repoRoot = path.join(root, "checkout");
  const dataRoot = path.join(root, "data");
  const binRoot = path.join(root, "bin");
  const cliPath = path.join(repoRoot, "dist", "cli.js");
  const buildPath = path.join(repoRoot, "dist", "build.json");
  const installPath = path.join(dataRoot, "state", "install.json");
  const digestModulePath = path.join(repoRoot, "scripts", "lib", "build-inputs.mjs");
  await Promise.all([
    mkdir(path.join(repoRoot, "src"), { recursive: true }),
    mkdir(path.join(repoRoot, "tests"), { recursive: true }),
    mkdir(path.dirname(digestModulePath), { recursive: true }),
    mkdir(path.dirname(cliPath), { recursive: true }),
    mkdir(path.dirname(installPath), { recursive: true }),
    mkdir(binRoot, { recursive: true }),
  ]);
  await copyFile(path.join(process.cwd(), "scripts", "lib", "build-inputs.mjs"), digestModulePath);
  await writeFile(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({
      name: "paper-search-cli",
      version: "1.2.3",
      paperSearch: {
        buildInputs: ["src"],
        selfUpdateVerificationInputs: [
          "package.json",
          "package-lock.json",
          "scripts",
          "tests",
          "README.md",
        ],
      },
    })}\n`,
    "utf8",
  );
  await writeFile(path.join(repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  await writeFile(path.join(repoRoot, "src", "main.ts"), 'export const value = "built";\n', "utf8");
  await writeFile(path.join(repoRoot, "scripts", "install.mjs"), "// verification fixture\n", "utf8");
  await writeFile(path.join(repoRoot, "tests", "runtime.test.ts"), "// verification fixture\n", "utf8");
  await writeFile(path.join(repoRoot, "README.md"), "fixture documentation\n", "utf8");
  await writeFile(path.join(repoRoot, ".gitignore"), "dist/\n", "utf8");
  await writeFile(cliPath, '#!/usr/bin/env node\nconsole.log("fixture");\n', "utf8");

  let commit = "fixture-without-git";
  if (options.git !== false) {
    git(repoRoot, ["init"]);
    git(repoRoot, ["config", "user.email", "fixture@example.test"]);
    git(repoRoot, ["config", "user.name", "Fixture"]);
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "fixture"]);
    commit = git(repoRoot, ["rev-parse", "HEAD"]);
  }

  const digestModule = (await import(pathToFileURL(digestModulePath).href)) as DigestModule;
  const { buildInputs } = await digestModule.readPackageMetadata(repoRoot);
  const buildInputDigest = await digestModule.computeBuildInputDigest(repoRoot, buildInputs);
  const build: BuildIdentity = {
    schemaVersion: 1,
    packageVersion: "1.2.3",
    launcherProtocol: 1,
    builtAt: "2026-07-13T00:00:00.000Z",
    lockfileSha256: await digestModule.sha256File(path.join(repoRoot, "package-lock.json")),
    cliSha256: await digestModule.sha256File(cliPath),
    buildInputDigest,
    source: { commit, dirty: false },
  };
  const install: InstallState = {
    schemaVersion: 1,
    checkoutRealpath: repoRoot,
    binRoot,
    sourceManagementMode: "user-managed",
    launcherProtocol: 1,
    buildIdentity: {
      packageVersion: build.packageVersion,
      buildInputDigest: build.buildInputDigest,
      lockfileSha256: build.lockfileSha256,
      source: build.source,
      builtAt: build.builtAt,
    },
    projections: [],
    shims: [],
  };
  await writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`, "utf8");
  await writeFile(installPath, `${JSON.stringify(install, null, 2)}\n`, "utf8");
  return {
    repoRoot,
    build,
    install,
    paths: {
      repoRoot,
      configRoot: path.join(root, "config"),
      dataRoot,
      binRoot,
      installStatePath: installPath,
      buildIdentityPath: buildPath,
      selectedCliPath: cliPath,
    },
  };
}

describe("installed build health", () => {
  it("reports a selected build with matching source and installer identity as healthy", async () => {
    const fixture = await createFixture();
    const health = await inspectInstallHealth(fixture.paths);

    expect(health.summary.status).toBe("healthy");
    expect(health.checks).toMatchObject({
      cliIntegrity: { status: "healthy" },
      lockfile: { status: "healthy" },
      buildInputs: { status: "healthy" },
      sourceGit: { status: "healthy" },
      installStateIdentity: { status: "healthy" },
      launcherProtocol: { status: "healthy" },
    });
  });

  it("reports modified, deleted, and relevant-untracked build inputs as stale", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repoRoot, "src", "main.ts"), 'export const value = "changed";\n');

    let health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("stale");
    expect(health.checks.buildInputs.status).toBe("stale");

    await (await import("node:fs/promises")).unlink(path.join(fixture.repoRoot, "src", "main.ts"));
    health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("stale");
    expect(health.checks.buildInputs).toMatchObject({ status: "stale" });

    await writeFile(path.join(fixture.repoRoot, "src", "main.ts"), 'export const value = "built";\n');
    await writeFile(path.join(fixture.repoRoot, "src", "untracked.ts"), "export {};\n", "utf8");
    health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("stale");
    expect(health.checks.buildInputs.status).toBe("stale");
  });

  it("does not mix installer, test, or documentation verification assets into runtime freshness", async () => {
    const fixture = await createFixture();
    await Promise.all([
      writeFile(path.join(fixture.repoRoot, "scripts", "install.mjs"), "// changed installer\n", "utf8"),
      writeFile(path.join(fixture.repoRoot, "tests", "runtime.test.ts"), "// changed test\n", "utf8"),
      writeFile(path.join(fixture.repoRoot, "README.md"), "changed documentation\n", "utf8"),
    ]);

    const health = await inspectInstallHealth(fixture.paths);
    expect(health.checks.buildInputs.status).toBe("healthy");
    expect(health.checks.sourceGit.status).toBe("stale");
  });

  it("distinguishes stale lock/install identity from corrupt CLI/protocol state", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repoRoot, "package-lock.json"), '{"lockfileVersion":2}\n', "utf8");

    let health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("stale");
    expect(health.checks.lockfile).toMatchObject({ status: "stale", expected: fixture.build.lockfileSha256 });

    await writeFile(path.join(fixture.repoRoot, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
    await writeFile(fixture.paths.selectedCliPath, "corrupt CLI bytes\n", "utf8");
    health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("corrupt");
    expect(health.checks.cliIntegrity).toMatchObject({ status: "corrupt", expected: fixture.build.cliSha256 });

    await writeFile(fixture.paths.selectedCliPath, '#!/usr/bin/env node\nconsole.log("fixture");\n', "utf8");
    const changedInstall = {
      ...fixture.install,
      launcherProtocol: 2,
      buildIdentity: { ...fixture.install.buildIdentity, packageVersion: "0.0.0" },
    };
    await writeFile(fixture.paths.installStatePath, `${JSON.stringify(changedInstall)}\n`, "utf8");
    health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("corrupt");
    expect(health.checks.launcherProtocol.status).toBe("corrupt");
    expect(health.checks.installStateIdentity.status).toBe("stale");

    await writeFile(fixture.paths.installStatePath, `${JSON.stringify(fixture.install)}\n`, "utf8");
    const buildWithoutCliHash = { ...fixture.build, cliSha256: undefined };
    await writeFile(fixture.paths.buildIdentityPath, `${JSON.stringify(buildWithoutCliHash)}\n`, "utf8");
    health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("unknown");
    expect(health.checks.cliIntegrity.status).toBe("unknown");
  });

  it("reports a clean checkout at a newer commit as stale", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repoRoot, "README.md"), "new commit\n", "utf8");
    git(fixture.repoRoot, ["add", "README.md"]);
    git(fixture.repoRoot, ["commit", "-m", "advance source"]);

    const health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("stale");
    expect(health.checks.buildInputs.status).toBe("healthy");
    expect(health.checks.sourceGit).toMatchObject({ status: "stale" });
  });

  it("reports missing Git metadata as unavailable rather than healthy", async () => {
    const fixture = await createFixture({ git: false });

    const health = await inspectInstallHealth(fixture.paths);
    expect(health.summary.status).toBe("unavailable");
    expect(health.summary.healthy).toBe(false);
    expect(health.checks.sourceGit.status).toBe("unavailable");
    expect(health.checks.sourceGit.message).toContain("Git source identity is unavailable");
  });

});
