import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallPaths, InstallState } from "../../src/runtime/installLayout.js";
import {
  createSelfUpdateService,
  SelfUpdateBlockedError,
  type ApplyPreparedTargetContext,
  type PreparedTargetContext,
} from "../../src/runtime/selfUpdate.js";
import {
  PRODUCTION_OFFICIAL_ORIGIN_POLICY,
  type OfficialOriginPolicy,
} from "../../src/runtime/selfUpdatePolicy.js";

const tempDirs: string[] = [];

interface Fixture {
  root: string;
  seedRoot: string;
  repoRoot: string;
  remoteRoot: string;
  paths: InstallPaths;
  env: NodeJS.ProcessEnv;
  policy: OfficialOriginPolicy;
  initialCommit: string;
  projectionPath: string;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function launcherSource(protocols: number[]): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const supported = ${JSON.stringify(protocols)};
let directory = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
for (;;) {
  const marker = path.join(directory, "package.json");
  if (existsSync(marker)) {
    try {
      if (JSON.parse(readFileSync(marker, "utf8")).name === "paper-search-cli") break;
    } catch {}
  }
  const parent = path.dirname(directory);
  if (parent === directory) process.exit(90);
  directory = parent;
}
const build = JSON.parse(readFileSync(path.join(directory, "dist", "build.json"), "utf8"));
if (!supported.includes(build.launcherProtocol)) process.exit(91);
const child = spawnSync(process.execPath, [path.join(directory, "dist", "cli.js"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(child.status ?? 1);
`;
}

async function writeBundle(
  distPath: string,
  version: string,
  protocol: number,
  commit: string,
): Promise<Record<string, unknown>> {
  await mkdir(distPath, { recursive: true });
  const cli = `#!/usr/bin/env node
const arg = process.argv[2];
if (arg === "--version") console.log(${JSON.stringify(version)});
else if (arg === "--help") console.log("fixture help");
else console.log(${JSON.stringify(version)});
`;
  const cliPath = path.join(distPath, "cli.js");
  await writeFile(cliPath, cli, "utf8");
  const build = {
    schemaVersion: 1,
    packageVersion: version,
    launcherProtocol: protocol,
    builtAt: "2026-07-14T00:00:00.000Z",
    lockfileSha256: "b".repeat(64),
    cliSha256: createHash("sha256").update(cli).digest("hex"),
    buildInputDigest: { algorithm: "sha256", schemaVersion: 1, value: "a".repeat(64) },
    source: { commit, dirty: false },
  };
  await writeFile(path.join(distPath, "build.json"), `${JSON.stringify(build, null, 2)}\n`, "utf8");
  return build;
}

async function createFixture(mode: InstallState["sourceManagementMode"] = "user-managed"): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-self-update-"));
  tempDirs.push(root);
  const seedRoot = path.join(root, "seed");
  const remoteRoot = path.join(root, "official.git");
  const repoRoot = path.join(root, "checkout");
  await mkdir(path.join(seedRoot, "skills", "paper-search-cli", "scripts"), { recursive: true });
  await mkdir(path.join(seedRoot, "scripts", "lib"), { recursive: true });
  await writeFile(
    path.join(seedRoot, "package.json"),
    '{"name":"paper-search-cli","private":true,"type":"module"}\n',
    "utf8",
  );
  await writeFile(
    path.join(seedRoot, ".gitignore"),
    "dist/\ndist.previous/\n.paper-search-runtime/\n",
    "utf8",
  );
  await writeFile(path.join(seedRoot, "version.txt"), "1.0.0\n", "utf8");
  await writeFile(path.join(seedRoot, "protocol.txt"), "1\n", "utf8");
  await writeFile(
    path.join(seedRoot, "skills", "paper-search-cli", "scripts", "paper-search.mjs"),
    launcherSource([1]),
    "utf8",
  );
  await cp(
    path.join(process.cwd(), "scripts", "lib", "owned-file-lock.mjs"),
    path.join(seedRoot, "scripts", "lib", "owned-file-lock.mjs"),
  );
  git(seedRoot, ["init", "-b", "main"]);
  git(seedRoot, ["config", "user.email", "fixture@example.test"]);
  git(seedRoot, ["config", "user.name", "Fixture"]);
  git(seedRoot, ["add", "."]);
  git(seedRoot, ["commit", "-m", "initial"]);
  const initialCommit = git(seedRoot, ["rev-parse", "HEAD"]);
  git(root, ["init", "--bare", remoteRoot]);
  git(seedRoot, ["remote", "add", "origin", remoteRoot]);
  git(seedRoot, ["push", "-u", "origin", "main"]);
  git(root, ["clone", "--branch", "main", remoteRoot, repoRoot]);
  git(repoRoot, ["config", "user.email", "fixture@example.test"]);
  git(repoRoot, ["config", "user.name", "Fixture"]);

  const dataRoot = path.join(root, "data");
  const binRoot = path.join(root, "bin");
  const installStatePath = path.join(dataRoot, "state", "install.json");
  const buildIdentityPath = path.join(repoRoot, "dist", "build.json");
  const selectedCliPath = path.join(repoRoot, "dist", "cli.js");
  const skillsRoot = path.join(root, "skills");
  const projectionPath = path.join(skillsRoot, "paper-search-cli");
  await Promise.all([mkdir(path.dirname(installStatePath), { recursive: true }), mkdir(skillsRoot, { recursive: true })]);
  await symlink(
    path.join(repoRoot, "skills", "paper-search-cli"),
    projectionPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  const build = await writeBundle(path.join(repoRoot, "dist"), "1.0.0", 1, initialCommit);
  const install: InstallState & Record<string, unknown> = {
    schemaVersion: 1,
    installId: "fixture-install",
    checkoutRealpath: repoRoot,
    binRoot,
    sourceManagementMode: mode,
    launcherProtocol: 1,
    buildIdentity: {
      packageVersion: "1.0.0",
      buildInputDigest: build.buildInputDigest,
      lockfileSha256: build.lockfileSha256,
      source: build.source,
      builtAt: build.builtAt,
    },
    projections: [
      {
        path: projectionPath,
        target: path.join(repoRoot, "skills", "paper-search-cli"),
        linkType: process.platform === "win32" ? "junction" : "symlink",
      },
    ],
    shims: [],
  };
  await writeFile(installStatePath, `${JSON.stringify(install, null, 2)}\n`, "utf8");
  return {
    root,
    seedRoot,
    repoRoot,
    remoteRoot,
    initialCommit,
    projectionPath,
    paths: {
      repoRoot,
      configRoot: path.join(root, "config"),
      dataRoot,
      binRoot,
      installStatePath,
      buildIdentityPath,
      selectedCliPath,
    },
    env: {
      ...process.env,
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: dataRoot,
    },
    policy: {
      status: "available",
      policyId: "fixture-official-origin-v1",
      repositories: [{ fetchUrl: remoteRoot, branches: ["main"] }],
    },
  };
}

async function advanceRemote(
  fixture: Fixture,
  options: { version?: string; protocol?: number; launcherProtocols?: number[] } = {},
): Promise<string> {
  await writeFile(path.join(fixture.seedRoot, "version.txt"), `${options.version ?? "2.0.0"}\n`, "utf8");
  if (options.protocol !== undefined) {
    await writeFile(path.join(fixture.seedRoot, "protocol.txt"), `${options.protocol}\n`, "utf8");
  }
  if (options.launcherProtocols) {
    await writeFile(
      path.join(fixture.seedRoot, "skills", "paper-search-cli", "scripts", "paper-search.mjs"),
      launcherSource(options.launcherProtocols),
      "utf8",
    );
  }
  git(fixture.seedRoot, ["add", "."]);
  git(fixture.seedRoot, ["commit", "-m", `advance ${options.version ?? "2.0.0"}`]);
  git(fixture.seedRoot, ["push", "origin", "main"]);
  return git(fixture.seedRoot, ["rev-parse", "HEAD"]);
}

async function prepareFixtureTarget(context: PreparedTargetContext): Promise<void> {
  const version = (await readFile(path.join(context.worktreePath, "version.txt"), "utf8")).trim();
  const protocol = Number.parseInt(
    (await readFile(path.join(context.worktreePath, "protocol.txt"), "utf8")).trim(),
    10,
  );
  await writeBundle(path.join(context.worktreePath, "dist"), version, protocol, context.targetCommit);
}

async function applyFixtureTarget(context: ApplyPreparedTargetContext): Promise<void> {
  const currentDist = path.join(context.repoRoot, "dist");
  const previousDist = path.join(context.repoRoot, "dist.previous");
  await rm(previousDist, { recursive: true, force: true });
  await cp(currentDist, previousDist, { recursive: true });
  await rm(currentDist, { recursive: true, force: true });
  await cp(context.candidateDistPath, currentDist, { recursive: true });
  for (const projection of context.install.projections) {
    await rm(projection.path, { recursive: true, force: true });
    await mkdir(path.dirname(projection.path), { recursive: true });
    await symlink(
      path.join(context.repoRoot, "skills", "paper-search-cli"),
      projection.path,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  const build = JSON.parse(await readFile(path.join(currentDist, "build.json"), "utf8")) as Record<string, unknown>;
  const install = JSON.parse(await readFile(path.join(context.env.PAPER_SEARCH_TEST_DATA_ROOT!, "state", "install.json"), "utf8")) as Record<string, unknown>;
  install.launcherProtocol = build.launcherProtocol;
  install.buildIdentity = {
    packageVersion: build.packageVersion,
    buildInputDigest: build.buildInputDigest,
    lockfileSha256: build.lockfileSha256,
    source: build.source,
    builtAt: build.builtAt,
  };
  await writeFile(
    path.join(context.env.PAPER_SEARCH_TEST_DATA_ROOT!, "state", "install.json"),
    `${JSON.stringify(install, null, 2)}\n`,
    "utf8",
  );
}

function service(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createSelfUpdateService>[0]> = {},
) {
  return createSelfUpdateService({
    officialOriginPolicy: fixture.policy,
    paths: fixture.paths,
    env: fixture.env,
    prepareTarget: prepareFixtureTarget,
    applyPreparedTarget: applyFixtureTarget,
    lockTimeoutMs: 1_000,
    ...overrides,
  });
}

describe("sealed self-update policy and retained-checkout updater", () => {
  it("seals production authority to the exact official HTTPS main branch", () => {
    const previous = process.env.PAPER_SEARCH_OFFICIAL_ORIGIN;
    try {
      process.env.PAPER_SEARCH_OFFICIAL_ORIGIN = "https://attacker.invalid/repository.git";
      expect(PRODUCTION_OFFICIAL_ORIGIN_POLICY).toMatchObject({
        status: "available",
        policyId: "paper-search-official-origin-v1",
        repositories: [
          {
            fetchUrl: "https://github.com/X-T-E-R/paper-search-cli.git",
            branches: ["main"],
          },
        ],
      });
      expect(JSON.stringify(PRODUCTION_OFFICIAL_ORIGIN_POLICY)).not.toContain("attacker.invalid");
    } finally {
      if (previous === undefined) delete process.env.PAPER_SEARCH_OFFICIAL_ORIGIN;
      else process.env.PAPER_SEARCH_OFFICIAL_ORIGIN = previous;
    }
  });

  it("persists explicit self-update opt-in only for a clean installer-owned official upstream", async () => {
    const fixture = await createFixture();
    const updater = service(fixture);
    const plan = await updater.planMode("self-update");
    expect(plan).toMatchObject({ blocked: false, before: "user-managed", after: "self-update" });

    const applied = await updater.executeMode("self-update", true);
    expect(applied.applied).toBe(true);
    const state = JSON.parse(await readFile(fixture.paths.installStatePath, "utf8"));
    expect(state.sourceManagementMode).toBe("self-update");

    await writeFile(path.join(fixture.repoRoot, "dirty.txt"), "dirty\n", "utf8");
    const dirty = await updater.planMode("self-update");
    expect(dirty.blockers).toContain("Self-update opt-in requires a clean checkout.");
  }, 30_000);

  it("reports missing opt-in and treats an opted-in current target as an idempotent no-op", async () => {
    const managed = await createFixture("user-managed");
    const managedPlan = await service(managed).planUpdate();
    expect(managedPlan.blockers).toContain(
      "Self-update is not enabled; review `paper-search self mode self-update` first.",
    );

    const optedIn = await createFixture("self-update");
    const updater = service(optedIn);
    const plan = await updater.planUpdate();
    expect(plan).toMatchObject({ blocked: false, relation: "up-to-date", actions: [] });
    await expect(updater.executeUpdate(true)).resolves.toMatchObject({ applied: false });
  }, 30_000);

  it("builds before fast-forward, repairs links, selects the target, and retains the prior dist", async () => {
    const fixture = await createFixture("self-update");
    const targetCommit = await advanceRemote(fixture);
    await rm(fixture.projectionPath, { recursive: true, force: true });
    const updater = service(fixture);

    expect(git(fixture.repoRoot, ["rev-parse", "origin/main"])).toBe(fixture.initialCommit);
    const plan = await updater.planUpdate();
    expect(plan).toMatchObject({ blocked: false, relation: "behind", targetCommit });
    expect(git(fixture.repoRoot, ["rev-parse", "origin/main"])).toBe(fixture.initialCommit);
    const result = await updater.executeUpdate(true);

    expect(result.applied).toBe(true);
    expect(git(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(targetCommit);
    expect(
      spawnSync(process.execPath, [fixture.paths.selectedCliPath, "--version"], { encoding: "utf8" }).stdout.trim(),
    ).toBe("2.0.0");
    expect(
      spawnSync(process.execPath, [path.join(fixture.repoRoot, "dist.previous", "cli.js"), "--version"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("1.0.0");
    expect(await readFile(path.join(fixture.projectionPath, "scripts", "paper-search.mjs"), "utf8")).toContain(
      "const supported",
    );
    const state = JSON.parse(await readFile(fixture.paths.installStatePath, "utf8"));
    expect(state.buildIdentity.source.commit).toBe(targetCommit);
    await expect(readFile(path.join(fixture.paths.dataRoot, "state", "self-update-recovery.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects dirty, local-only, diverged, and missing-upstream checkouts", async () => {
    const dirtyFixture = await createFixture("self-update");
    await advanceRemote(dirtyFixture);
    await writeFile(path.join(dirtyFixture.repoRoot, "dirty.txt"), "dirty\n", "utf8");
    expect((await service(dirtyFixture).planUpdate()).blockers).toContain("Self-update requires a clean checkout.");

    const aheadFixture = await createFixture("self-update");
    await writeFile(path.join(aheadFixture.repoRoot, "ahead.txt"), "ahead\n", "utf8");
    git(aheadFixture.repoRoot, ["add", "ahead.txt"]);
    git(aheadFixture.repoRoot, ["commit", "-m", "local only"]);
    expect((await service(aheadFixture).planUpdate()).relation).toBe("ahead");
    expect((await service(aheadFixture).planUpdate()).blockers).toContain("The checkout has local-only commits.");

    const divergedFixture = await createFixture("self-update");
    await advanceRemote(divergedFixture);
    await writeFile(path.join(divergedFixture.repoRoot, "local.txt"), "local\n", "utf8");
    git(divergedFixture.repoRoot, ["add", "local.txt"]);
    git(divergedFixture.repoRoot, ["commit", "-m", "local divergence"]);
    const diverged = await service(divergedFixture).planUpdate();
    expect(diverged.relation).toBe("diverged");
    expect(diverged.blockers).toContain("The checkout and official upstream have diverged.");

    const upstreamFixture = await createFixture("self-update");
    git(upstreamFixture.repoRoot, ["branch", "--unset-upstream"]);
    expect((await service(upstreamFixture).planUpdate()).blockers).toContain(
      "Self-update requires a configured branch upstream.",
    );
  }, 30_000);

  it("leaves checkout, dist, and install state unchanged when target verification fails", async () => {
    const fixture = await createFixture("self-update");
    await advanceRemote(fixture);
    const beforeState = await readFile(fixture.paths.installStatePath, "utf8");
    const updater = service(fixture, {
      prepareTarget: async () => {
        throw new Error("injected target build failure");
      },
    });

    await expect(updater.executeUpdate(true)).rejects.toThrow("injected target build failure");
    expect(git(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(fixture.initialCommit);
    expect(
      spawnSync(process.execPath, [fixture.paths.selectedCliPath, "--version"], { encoding: "utf8" }).stdout.trim(),
    ).toBe("1.0.0");
    expect(await readFile(fixture.paths.installStatePath, "utf8")).toBe(beforeState);
  }, 30_000);

  it("requires a launcher bridge before a protocol-breaking fast-forward", async () => {
    const fixture = await createFixture("self-update");
    await advanceRemote(fixture, { protocol: 2, launcherProtocols: [2] });
    await expect(service(fixture).executeUpdate(true)).rejects.toThrow(/Launcher bridge/);
    expect(git(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(fixture.initialCommit);
  }, 30_000);

  it("retains prior dist and deterministic recovery state after a post-fast-forward failure", async () => {
    const fixture = await createFixture("self-update");
    const targetCommit = await advanceRemote(fixture);
    const updater = service(fixture, {
      applyPreparedTarget: async (context) => {
        await applyFixtureTarget(context);
        throw new Error("injected setup repair failure");
      },
    });

    await expect(updater.executeUpdate(true)).rejects.toThrow("canonical checkout advanced");
    expect(git(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(targetCommit);
    expect(
      spawnSync(process.execPath, [path.join(fixture.repoRoot, "dist.previous", "cli.js"), "--version"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("1.0.0");
    const recovery = JSON.parse(
      await readFile(path.join(fixture.paths.dataRoot, "state", "self-update-recovery.json"), "utf8"),
    );
    expect(recovery).toMatchObject({
      schemaVersion: 1,
      phase: "post-fast-forward-failed",
      previousCommit: fixture.initialCommit,
      targetCommit,
    });
    expect(recovery.recovery.args.at(-1)).toBe("--apply");
  }, 30_000);

  it("fails closed and records recovery when post-fast-forward checkout invariants drift", async () => {
    const fixture = await createFixture("self-update");
    const targetCommit = await advanceRemote(fixture);
    const hooksRoot = path.join(fixture.root, "hooks");
    const postMergeHook = path.join(hooksRoot, "post-merge");
    await mkdir(hooksRoot, { recursive: true });
    await writeFile(
      postMergeHook,
      "#!/bin/sh\nprintf 'hook mutation\\n' > post-merge-dirty.txt\n",
      "utf8",
    );
    await chmod(postMergeHook, 0o755);
    git(fixture.repoRoot, ["config", "core.hooksPath", hooksRoot]);
    let applyCalled = false;

    await expect(
      service(fixture, {
        applyPreparedTarget: async () => {
          applyCalled = true;
        },
      }).executeUpdate(true),
    ).rejects.toThrow("Post-fast-forward invariants failed");

    expect(applyCalled).toBe(false);
    expect(git(fixture.repoRoot, ["rev-parse", "HEAD"])).toBe(targetCommit);
    expect(
      spawnSync(process.execPath, [fixture.paths.selectedCliPath, "--version"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("1.0.0");
    const recovery = JSON.parse(
      await readFile(path.join(fixture.paths.dataRoot, "state", "self-update-recovery.json"), "utf8"),
    );
    expect(recovery).toMatchObject({
      schemaVersion: 1,
      phase: "post-fast-forward-failed",
      previousCommit: fixture.initialCommit,
      targetCommit,
    });
    expect(recovery.error).toContain("Post-fast-forward invariants failed");
  }, 30_000);

  it("uses the canonical repo lock and times out behind a concurrent setup/update owner", async () => {
    const fixture = await createFixture("self-update");
    await advanceRemote(fixture);
    const lockModuleUrl = pathToFileURL(
      path.join(fixture.repoRoot, "scripts", "lib", "owned-file-lock.mjs"),
    ).href.replace(/%7E/giu, "~");
    const lockModule = await import(
      /* @vite-ignore */ lockModuleUrl
    ) as {
      acquireOwnedFileLock(
        filePath: string,
        options: { timeoutMs: number; command: string },
      ): Promise<{ release(): Promise<void> }>;
    };
    const lock = await lockModule.acquireOwnedFileLock(
      path.join(fixture.repoRoot, ".paper-search-runtime", "locks", "repo.lock"),
      { timeoutMs: 1_000, command: "concurrent setup" },
    );
    try {
      const updater = service(fixture, { lockTimeoutMs: 80 });
      await expect(updater.planUpdate()).rejects.toThrow("Timed out waiting for lock");
    } finally {
      await lock.release();
    }
  });

  it("keeps the exact upstream URL private while exposing a credential-sanitized status", async () => {
    const fixture = await createFixture();
    const credentialedUrl = "https://fixture-user:top-secret@example.invalid/paper-search.git";
    git(fixture.repoRoot, ["remote", "set-url", "origin", credentialedUrl]);
    const credentialedPolicy: OfficialOriginPolicy = {
      status: "available",
      policyId: "credential-sanitization-fixture",
      repositories: [{ fetchUrl: credentialedUrl, branches: ["main"] }],
    };

    const status = await service(fixture, {
      officialOriginPolicy: credentialedPolicy,
    }).inspectStatus();

    expect(status.officialPolicy.matched).toBe(true);
    expect(status.git.upstreamFetchUrl).not.toContain("fixture-user");
    expect(status.git.upstreamFetchUrl).not.toContain("top-secret");
  });

  it("does not expose upstream credentials when remote target resolution fails", async () => {
    const fixture = await createFixture("self-update");
    const missingPath = path.join(fixture.root, "missing.git").split(path.sep).join("/");
    const credentialedUrl = `file://fixture-user:top-secret@localhost/${missingPath.replace(/^\/+/, "")}`;
    git(fixture.repoRoot, ["remote", "set-url", "origin", credentialedUrl]);
    const credentialedPolicy: OfficialOriginPolicy = {
      status: "available",
      policyId: "credential-resolution-fixture",
      repositories: [{ fetchUrl: credentialedUrl, branches: ["main"] }],
    };

    const plan = await service(fixture, {
      officialOriginPolicy: credentialedPolicy,
    }).planUpdate();
    const serialized = JSON.stringify(plan);

    expect(plan.blocked).toBe(true);
    expect(serialized).not.toContain("fixture-user");
    expect(serialized).not.toContain("top-secret");
    expect(plan.blockers.join(" ")).toContain("Official upstream target is unavailable");
  });

  it("fails closed when an injected policy does not match the configured upstream", async () => {
    const fixture = await createFixture();
    const wrongPolicy: OfficialOriginPolicy = {
      status: "available",
      policyId: "wrong-official-origin",
      repositories: [{ fetchUrl: path.join(fixture.root, "other.git"), branches: ["main"] }],
    };
    const plan = await service(fixture, { officialOriginPolicy: wrongPolicy }).planMode("self-update");
    expect(plan.blocked).toBe(true);
    expect(plan.officialPolicy.matched).toBe(false);
    await expect(
      service(fixture, { officialOriginPolicy: wrongPolicy }).executeMode("self-update", true),
    ).rejects.toBeInstanceOf(SelfUpdateBlockedError);
  });
});
