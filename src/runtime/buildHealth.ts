import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { BuildIdentity, InstallPaths, InstallState } from "./installLayout.js";

export type InstallHealthStatus = "healthy" | "stale" | "corrupt" | "unavailable" | "unknown";

export interface InstallHealthCheck {
  status: InstallHealthStatus;
  message: string;
  action?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface BuildHealthChecks {
  buildIdentity: InstallHealthCheck;
  cliIntegrity: InstallHealthCheck;
  lockfile: InstallHealthCheck;
  buildInputs: InstallHealthCheck;
  sourceGit: InstallHealthCheck;
  installStateIdentity: InstallHealthCheck;
  launcherProtocol: InstallHealthCheck;
}

interface JsonReadResult<T> {
  value: T | null;
  error?: string;
}

interface BuildInputModule {
  readPackageMetadata(repoRoot: string): Promise<{ buildInputs: string[] }>;
  computeBuildInputDigest(
    repoRoot: string,
    buildInputs: string[],
  ): Promise<{ algorithm: string; schemaVersion: number; value: string; fileCount: number }>;
  sha256File(filePath: string): Promise<string>;
}

export interface BuildHealthResult {
  build: BuildIdentity | null;
  install: InstallState | null;
  checks: BuildHealthChecks;
}

const SETUP_ACTION = "Run `paper-search setup` to review the repair plan, then rerun with `--apply`.";

function check(
  status: InstallHealthStatus,
  message: string,
  details: Omit<InstallHealthCheck, "status" | "message"> = {},
): InstallHealthCheck {
  return { status, message, ...details };
}

async function readJson<T>(filePath: string, validate: (value: unknown) => value is T): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null };
    return { value: null, error: formatError(error) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed)
      ? { value: parsed }
      : { value: null, error: `Unsupported or malformed metadata in ${filePath}` };
  } catch (error) {
    return { value: null, error: `Invalid JSON in ${filePath}: ${formatError(error)}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is BuildIdentity["buildInputDigest"] {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    /^[a-f0-9]{64}$/u.test(value.value) &&
    typeof value.schemaVersion === "number" &&
    typeof value.algorithm === "string"
  );
}

function isBuildIdentity(value: unknown): value is BuildIdentity {
  const sha256 = /^[a-f0-9]{64}$/u;
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.packageVersion === "string" &&
    typeof value.launcherProtocol === "number" &&
    Number.isInteger(value.launcherProtocol) &&
    value.launcherProtocol > 0 &&
    typeof value.builtAt === "string" &&
    typeof value.lockfileSha256 === "string" &&
    sha256.test(value.lockfileSha256) &&
    isDigest(value.buildInputDigest) &&
    (value.cliSha256 === undefined || (typeof value.cliSha256 === "string" && sha256.test(value.cliSha256))) &&
    (value.source === undefined ||
      (isRecord(value.source) &&
        (value.source.commit === undefined || value.source.commit === null || typeof value.source.commit === "string") &&
        (value.source.dirty === undefined || typeof value.source.dirty === "boolean")))
  );
}

function isInstallState(value: unknown): value is InstallState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.checkoutRealpath === "string" &&
    (value.binRoot === undefined || typeof value.binRoot === "string") &&
    (value.sourceManagementMode === "user-managed" || value.sourceManagementMode === "self-update") &&
    typeof value.launcherProtocol === "number" &&
    Array.isArray(value.projections) &&
    value.projections.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.target === "string" &&
        typeof entry.linkType === "string",
    ) &&
    Array.isArray(value.shims) &&
    value.shims.every(
      (entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.sha256 === "string",
    ) &&
    (value.buildIdentity === undefined || isRecord(value.buildIdentity))
  );
}

async function loadBuildInputModule(repoRoot: string): Promise<BuildInputModule> {
  const modulePath = path.join(repoRoot, "scripts", "lib", "build-inputs.mjs");
  // This is deliberately loaded from the retained checkout. The installer and
  // health check therefore execute the exact same digest implementation.
  const moduleUrl = pathToFileURL(modulePath).href.replace(/%7E/giu, "~");
  return (await import(
    /* @vite-ignore */ moduleUrl
  )) as BuildInputModule;
}

async function sha256Fallback(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function inspectCliIntegrity(
  paths: InstallPaths,
  build: BuildIdentity | null,
  buildError?: string,
): Promise<InstallHealthCheck> {
  if (!build) {
    return check(buildError ? "unknown" : "unavailable", "CLI integrity cannot be checked without a valid build identity.", {
      action: SETUP_ACTION,
    });
  }
  if (!build.cliSha256) {
    return check("unknown", "The build identity does not declare the selected CLI SHA-256.", {
      action: SETUP_ACTION,
    });
  }
  try {
    let actual: string;
    try {
      const digestModule = await loadBuildInputModule(paths.repoRoot);
      actual = await digestModule.sha256File(paths.selectedCliPath);
    } catch {
      actual = await sha256Fallback(paths.selectedCliPath);
    }
    return actual === build.cliSha256
      ? check("healthy", "Selected CLI bytes match build.json.", { expected: build.cliSha256, actual })
      : check("corrupt", "Selected CLI bytes do not match build.json.", {
          expected: build.cliSha256,
          actual,
          action: SETUP_ACTION,
        });
  } catch (error) {
    return check(isMissing(error) ? "corrupt" : "unavailable", `Selected CLI could not be hashed: ${formatError(error)}`, {
      expected: build.cliSha256,
      action: SETUP_ACTION,
    });
  }
}

async function inspectLockfile(paths: InstallPaths, build: BuildIdentity | null): Promise<InstallHealthCheck> {
  if (!build) return check("unknown", "Lockfile integrity cannot be checked without a valid build identity.");
  const lockfilePath = path.join(paths.repoRoot, "package-lock.json");
  try {
    let actual: string;
    try {
      actual = await (await loadBuildInputModule(paths.repoRoot)).sha256File(lockfilePath);
    } catch {
      actual = await sha256Fallback(lockfilePath);
    }
    return actual === build.lockfileSha256
      ? check("healthy", "package-lock.json matches the selected build.", { expected: build.lockfileSha256, actual })
      : check("stale", "package-lock.json changed after the selected build.", {
          expected: build.lockfileSha256,
          actual,
          action: SETUP_ACTION,
        });
  } catch (error) {
    const packagePresent = await readFile(path.join(paths.repoRoot, "package.json"), "utf8")
      .then(() => true)
      .catch(() => false);
    const status = isMissing(error) && packagePresent ? "stale" : "unavailable";
    return check(status, `Current lockfile could not be hashed: ${formatError(error)}`, {
      expected: build.lockfileSha256,
      action: status === "stale" ? SETUP_ACTION : "Restore access to the retained source checkout.",
    });
  }
}

async function inspectBuildInputs(paths: InstallPaths, build: BuildIdentity | null): Promise<InstallHealthCheck> {
  if (!build) return check("unknown", "Build inputs cannot be checked without a valid build identity.");
  if (build.buildInputDigest.algorithm !== "sha256" || build.buildInputDigest.schemaVersion !== 1) {
    return check("unknown", "The build-input digest uses an unsupported algorithm or schema.", {
      expected: { algorithm: "sha256", schemaVersion: 1 },
      actual: {
        algorithm: build.buildInputDigest.algorithm,
        schemaVersion: build.buildInputDigest.schemaVersion,
      },
      action: SETUP_ACTION,
    });
  }
  try {
    const digestModule = await loadBuildInputModule(paths.repoRoot);
    const { buildInputs } = await digestModule.readPackageMetadata(paths.repoRoot);
    const actual = await digestModule.computeBuildInputDigest(paths.repoRoot, buildInputs);
    return actual.value === build.buildInputDigest.value
      ? check("healthy", "Declared build inputs match the selected build.", {
          expected: build.buildInputDigest,
          actual,
        })
      : check("stale", "Declared build inputs changed after the selected build.", {
          expected: build.buildInputDigest,
          actual,
          action: SETUP_ACTION,
        });
  } catch (error) {
    const packagePresent = await readFile(path.join(paths.repoRoot, "package.json"), "utf8")
      .then(() => true)
      .catch(() => false);
    const status = packagePresent ? "stale" : "unavailable";
    return check(status, `Declared build inputs could not be recomputed: ${formatError(error)}`, {
      expected: build.buildInputDigest,
      action: status === "stale" ? SETUP_ACTION : "Restore access to the retained source checkout.",
    });
  }
}

function runGit(repoRoot: string, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || `git exited with status ${String(result.status)}` };
  }
  return { ok: true, stdout: result.stdout.trim() };
}

function inspectSourceGit(paths: InstallPaths, build: BuildIdentity | null): InstallHealthCheck {
  const commit = runGit(paths.repoRoot, ["rev-parse", "HEAD"]);
  const dirty = runGit(paths.repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (!commit.ok || !dirty.ok) {
    const gitError = !commit.ok ? commit.error : !dirty.ok ? dirty.error : "unknown Git error";
    return check("unavailable", `Git source identity is unavailable: ${gitError}`, {
      expected: build?.source ?? null,
      action: "Restore Git metadata or run from the retained checkout; do not treat this source as verified.",
    });
  }
  const actual = { commit: commit.stdout, dirty: dirty.stdout.length > 0 };
  if (!build?.source || typeof build.source.commit !== "string" || typeof build.source.dirty !== "boolean") {
    return check("unknown", "The selected build does not record a complete Git source identity.", {
      actual,
      action: SETUP_ACTION,
    });
  }
  const expected = { commit: build.source.commit, dirty: build.source.dirty };
  return expected.commit === actual.commit && expected.dirty === actual.dirty
    ? check("healthy", "Git commit and dirty state match the selected build.", { expected, actual })
    : check("stale", "Git commit or dirty state changed after the selected build.", {
        expected,
        actual,
        action: SETUP_ACTION,
      });
}

function identityProjection(build: BuildIdentity): Record<string, unknown> {
  return {
    packageVersion: build.packageVersion,
    buildInputDigest: build.buildInputDigest,
    lockfileSha256: build.lockfileSha256,
    source: build.source ?? null,
    builtAt: build.builtAt,
  };
}

function inspectInstallStateIdentity(build: BuildIdentity | null, install: InstallState | null): InstallHealthCheck {
  if (!install) {
    return check("unavailable", "Installer ownership state is missing.", { action: SETUP_ACTION });
  }
  if (!build) return check("unknown", "Install-state identity cannot be compared without a valid build identity.");
  if (!install.buildIdentity) {
    return check("unknown", "Install state does not record the selected build identity.", { action: SETUP_ACTION });
  }
  const expected = identityProjection(build);
  const actual = install.buildIdentity;
  return isDeepStrictEqual(actual, expected)
    ? check("healthy", "Install state selects the current build identity.", { expected, actual })
    : check("stale", "Install state selects a different build identity.", {
        expected,
        actual,
        action: SETUP_ACTION,
      });
}

function inspectLauncherProtocol(build: BuildIdentity | null, install: InstallState | null): InstallHealthCheck {
  if (!build || !install) {
    return check("unavailable", "Launcher protocol compatibility cannot be checked without build and install state.", {
      action: SETUP_ACTION,
    });
  }
  return build.launcherProtocol === install.launcherProtocol
    ? check("healthy", "Build and installer launcher protocols match.", {
        expected: build.launcherProtocol,
        actual: install.launcherProtocol,
      })
    : check("corrupt", "Build and installer launcher protocols are incompatible.", {
        expected: build.launcherProtocol,
        actual: install.launcherProtocol,
        action: SETUP_ACTION,
      });
}

export async function inspectBuildHealth(paths: InstallPaths): Promise<BuildHealthResult> {
  const [buildResult, installResult] = await Promise.all([
    readJson(paths.buildIdentityPath, isBuildIdentity),
    readJson(paths.installStatePath, isInstallState),
  ]);
  const build = buildResult.value;
  const install = installResult.value;
  const [cliIntegrity, lockfile, buildInputs] = await Promise.all([
    inspectCliIntegrity(paths, build, buildResult.error),
    inspectLockfile(paths, build),
    inspectBuildInputs(paths, build),
  ]);
  return {
    build,
    install,
    checks: {
      buildIdentity: build
        ? check("healthy", "Build identity is present and valid.", { actual: paths.buildIdentityPath })
        : check(buildResult.error ? "corrupt" : "unavailable", buildResult.error ?? "Build identity is missing.", {
            action: SETUP_ACTION,
          }),
      cliIntegrity,
      lockfile,
      buildInputs,
      sourceGit: inspectSourceGit(paths, build),
      installStateIdentity: installResult.error
        ? check("corrupt", installResult.error, { action: SETUP_ACTION })
        : inspectInstallStateIdentity(build, install),
      launcherProtocol: installResult.error
        ? check("unknown", "Launcher protocol cannot be checked because install state is invalid.")
        : inspectLauncherProtocol(build, install),
    },
  };
}
