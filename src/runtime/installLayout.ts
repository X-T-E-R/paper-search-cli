import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigRoot } from "../config/paths.js";
import {
  inspectBuildHealth,
  type BuildHealthChecks,
  type InstallHealthCheck,
  type InstallHealthStatus,
} from "./buildHealth.js";

export interface InstallPaths {
  repoRoot: string;
  configRoot: string;
  dataRoot: string;
  binRoot: string;
  installStatePath: string;
  buildIdentityPath: string;
  selectedCliPath: string;
}

export interface BuildIdentity {
  schemaVersion: number;
  packageVersion: string;
  launcherProtocol: number;
  builtAt: string;
  lockfileSha256: string;
  cliSha256?: string;
  buildInputDigest: { value: string; schemaVersion: number; algorithm: string };
  source?: { commit?: string | null; dirty?: boolean };
}

export interface InstallState {
  schemaVersion: number;
  checkoutRealpath: string;
  binRoot?: string;
  sourceManagementMode: "user-managed" | "self-update";
  launcherProtocol: number;
  buildIdentity?: Record<string, unknown>;
  projections: Array<{ path: string; target: string; linkType: string }>;
  shims: Array<{ path: string; sha256: string }>;
  updatedAt?: string;
}

function resolveRepoLayout(moduleUrl: string): { repoRoot: string; standaloneBundle: boolean } {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  let standaloneBundle: string | null = null;
  for (;;) {
    if (!standaloneBundle) {
      try {
        requireReadFile(path.join(directory, "build.json"));
        standaloneBundle = directory;
      } catch {
        // Continue looking for the retained checkout before using the fallback.
      }
    }
    try {
      const packageJson = JSON.parse(requireReadFile(path.join(directory, "package.json"))) as {
        name?: unknown;
      };
      if (packageJson.name === "paper-search-cli") return { repoRoot: directory, standaloneBundle: false };
    } catch {
      // The bundle normally lives at <repo>/dist/cli.js. Continue upward.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return standaloneBundle
        ? { repoRoot: standaloneBundle, standaloneBundle: true }
        : { repoRoot: path.dirname(path.dirname(fileURLToPath(moduleUrl))), standaloneBundle: false };
    }
    directory = parent;
  }
}

function requireReadFile(filePath: string): string {
  // Kept synchronous only for deterministic module-path discovery.
  return readFileSync(filePath, "utf8");
}

export function resolveInstallPaths(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): InstallPaths {
  const layout = resolveRepoLayout(moduleUrl);
  const repoRoot = layout.repoRoot;
  const dataRoot =
    env.PAPER_SEARCH_INSTALL_TEST_MODE === "1" && env.PAPER_SEARCH_TEST_DATA_ROOT
      ? path.resolve(env.PAPER_SEARCH_TEST_DATA_ROOT)
      : path.join(os.homedir(), ".paper-search");
  const binRoot =
    process.platform === "win32" && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "PaperSearch", "bin")
      : path.join(os.homedir(), ".local", "bin");
  return {
    repoRoot,
    configRoot: resolveConfigRoot(env),
    dataRoot,
    binRoot,
    installStatePath: path.join(dataRoot, "state", "install.json"),
    buildIdentityPath: layout.standaloneBundle
      ? path.join(repoRoot, "build.json")
      : path.join(repoRoot, "dist", "build.json"),
    selectedCliPath: layout.standaloneBundle
      ? path.join(repoRoot, "cli.js")
      : path.join(repoRoot, "dist", "cli.js"),
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export interface InstallHealthIssue extends InstallHealthCheck {
  check: keyof InstallationHealthChecks;
}

export interface InstallationHealthChecks extends BuildHealthChecks {
  checkout: InstallHealthCheck;
  projections: InstallHealthCheck;
  shims: InstallHealthCheck;
}

export interface InstallHealthReport {
  paths: InstallPaths;
  build: BuildIdentity | null;
  install: InstallState | null;
  checkoutMatches: boolean | null;
  projections: Array<{ path: string; healthy: boolean; status: InstallHealthStatus; reason?: string }>;
  shims: Array<{ path: string; healthy: boolean; status: InstallHealthStatus; reason?: string }>;
  path: { binRoot: string; onPath: boolean };
  checks: InstallationHealthChecks;
  summary: {
    status: InstallHealthStatus;
    healthy: boolean;
    counts: Record<InstallHealthStatus, number>;
    issues: InstallHealthIssue[];
  };
}

export function formatInstallHealthWarnings(health: Pick<InstallHealthReport, "summary">): string[] {
  return health.summary.issues.map(
    (issue) =>
      `Installation ${issue.check} is ${issue.status}: ${issue.message}${issue.action ? ` ${issue.action}` : ""}`,
  );
}

function aggregateStatus(checks: InstallationHealthChecks): InstallHealthReport["summary"] {
  const counts: Record<InstallHealthStatus, number> = {
    healthy: 0,
    stale: 0,
    corrupt: 0,
    unavailable: 0,
    unknown: 0,
  };
  const issues: InstallHealthIssue[] = [];
  for (const [name, value] of Object.entries(checks) as Array<[
    keyof InstallationHealthChecks,
    InstallHealthCheck,
  ]>) {
    counts[value.status] += 1;
    if (value.status !== "healthy") issues.push({ check: name, ...value });
  }
  const status: InstallHealthStatus = counts.corrupt
    ? "corrupt"
    : counts.stale
      ? "stale"
      : counts.unavailable
        ? "unavailable"
        : counts.unknown
          ? "unknown"
          : "healthy";
  return { status, healthy: status === "healthy", counts, issues };
}

function pathFailureStatus(error: unknown): InstallHealthStatus {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "corrupt" : "unavailable";
}

export async function inspectInstallHealth(paths = resolveInstallPaths()): Promise<InstallHealthReport> {
  const { build, install, checks: buildChecks } = await inspectBuildHealth(paths);
  const projections = await Promise.all(
    (install?.projections ?? []).map(async (entry) => {
      try {
        const stat = await lstat(entry.path);
        if (!stat.isSymbolicLink()) return { path: entry.path, healthy: false, status: "corrupt" as const, reason: "not a link" };
        const target = await realpath(entry.path);
        return samePath(target, entry.target)
          ? { path: entry.path, healthy: true, status: "healthy" as const }
          : { path: entry.path, healthy: false, status: "corrupt" as const, reason: `points to ${target}` };
      } catch (error) {
        return { path: entry.path, healthy: false, status: pathFailureStatus(error), reason: (error as Error).message };
      }
    }),
  );
  const shims = await Promise.all(
    (install?.shims ?? []).map(async (entry) => {
      try {
        const digest = createHash("sha256").update(await readFile(entry.path)).digest("hex");
        return digest === entry.sha256
          ? { path: entry.path, healthy: true, status: "healthy" as const }
          : { path: entry.path, healthy: false, status: "corrupt" as const, reason: "content differs from install state" };
      } catch (error) {
        return { path: entry.path, healthy: false, status: pathFailureStatus(error), reason: (error as Error).message };
      }
    }),
  );
  const checkoutMatches = install ? samePath(install.checkoutRealpath, paths.repoRoot) : null;
  const checks: InstallationHealthChecks = {
    ...buildChecks,
    checkout: !install
      ? { status: "unavailable", message: "Installer checkout ownership is unavailable.", action: "Run `paper-search setup` to review the installation plan." }
      : checkoutMatches
        ? { status: "healthy", message: "Install state belongs to this checkout." }
        : { status: "corrupt", message: "Install state belongs to a different checkout.", expected: paths.repoRoot, actual: install.checkoutRealpath, action: "Run `paper-search setup` and resolve the checkout ownership conflict." },
    projections: projections.every((entry) => entry.healthy)
      ? { status: "healthy", message: `${projections.length} managed skill projection(s) are healthy.` }
      : {
          status: projections.some((entry) => entry.status === "corrupt") ? "corrupt" : "unavailable",
          message: `${projections.filter((entry) => !entry.healthy).length} of ${projections.length} managed skill projection(s) are unhealthy.`,
          action: "Run `paper-search setup` to review projection repairs, then rerun with `--apply`.",
        },
    shims: shims.every((entry) => entry.healthy)
      ? { status: "healthy", message: `${shims.length} managed CLI shim(s) are healthy.` }
      : {
          status: shims.some((entry) => entry.status === "corrupt") ? "corrupt" : "unavailable",
          message: `${shims.filter((entry) => !entry.healthy).length} of ${shims.length} managed CLI shim(s) are unhealthy.`,
          action: "Run `paper-search setup` to review shim repairs, then rerun with `--apply`.",
        },
  };
  return {
    paths,
    build,
    install,
    checkoutMatches,
    projections,
    shims,
    path: {
      binRoot: install?.binRoot ?? paths.binRoot,
      onPath: String(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .some((entry) => samePath(entry, install?.binRoot ?? paths.binRoot)),
    },
    checks,
    summary: aggregateStatus(checks),
  };
}
