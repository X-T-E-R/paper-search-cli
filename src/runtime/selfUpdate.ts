import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteConfigFile } from "../config/userConfig.js";
import { tryAppendLifecycleEvent } from "./eventLedger.js";
import {
  resolveInstallPaths,
  type BuildIdentity,
  type InstallPaths,
  type InstallState,
} from "./installLayout.js";
import { acquireLock } from "./locks.js";
import { sanitizeUrlForDisplay } from "./sanitizeUrl.js";
import type {
  OfficialOriginPolicy,
  OfficialRepositoryOrigin,
} from "./selfUpdatePolicy.js";

export type SourceManagementMode = InstallState["sourceManagementMode"];

interface JsonRecord extends Record<string, unknown> {}

interface InstalledSourceContext {
  install: InstallState & JsonRecord;
  build: BuildIdentity & JsonRecord;
  launcherPath: string;
}

export interface LocalGitState {
  available: boolean;
  error?: string;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  dirtyEntries: string[];
  upstream: string | null;
  upstreamRemote: string | null;
  upstreamMergeRef: string | null;
  upstreamFetchUrl: string | null;
  cachedUpstreamCommit: string | null;
  cachedAhead: number | null;
  cachedBehind: number | null;
}

export interface OfficialPolicyStatus {
  status: OfficialOriginPolicy["status"];
  policyId: string;
  reason?: string;
  matched: boolean;
}

export interface SelfModePlan {
  schemaVersion: 1;
  operation: "mode";
  repoRoot: string;
  before: SourceManagementMode | null;
  after: SourceManagementMode;
  installerOwned: boolean;
  clean: boolean | null;
  officialPolicy: OfficialPolicyStatus;
  upstream: string | null;
  upstreamFetchUrl: string | null;
  actions: string[];
  blockers: string[];
  blocked: boolean;
  planDigest: string;
}

export type SelfUpdateRelation = "unknown" | "up-to-date" | "behind" | "ahead" | "diverged";

export interface SelfUpdatePlan {
  schemaVersion: 1;
  operation: "update";
  repoRoot: string;
  sourceManagementMode: SourceManagementMode | null;
  installerOwned: boolean;
  officialPolicy: OfficialPolicyStatus;
  git: LocalGitState;
  targetCommit: string | null;
  ahead: number | null;
  behind: number | null;
  relation: SelfUpdateRelation;
  currentBuildCommit: string | null;
  pendingRecoveryPath: string | null;
  actions: string[];
  blockers: string[];
  blocked: boolean;
  planDigest: string;
}

export interface SelfCheckoutStatus {
  sourceManagementMode: SourceManagementMode | null;
  installerOwned: boolean;
  officialPolicy: OfficialPolicyStatus;
  git: LocalGitState;
  pendingRecovery: JsonRecord | null;
  pendingRecoveryPath: string;
}

export interface PreparedTargetContext {
  repoRoot: string;
  worktreePath: string;
  targetCommit: string;
  operationRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface ApplyPreparedTargetContext {
  repoRoot: string;
  targetCommit: string;
  candidateDistPath: string;
  install: InstallState & JsonRecord;
  repoLockToken: string;
  env: NodeJS.ProcessEnv;
}

export interface SelfUpdateServiceDependencies {
  officialOriginPolicy: OfficialOriginPolicy;
  paths?: InstallPaths;
  env?: NodeJS.ProcessEnv;
  lockTimeoutMs?: number;
  prepareTarget?: (context: PreparedTargetContext) => Promise<void>;
  applyPreparedTarget?: (context: ApplyPreparedTargetContext) => Promise<void>;
}

export interface SelfMutationResult<TPlan> {
  plan: TPlan;
  applied: boolean;
  operationId?: string;
  auditWarnings?: string[];
}

interface OwnedFileLock {
  token: string;
  release(): Promise<void>;
}

interface OwnedFileLockModule {
  acquireOwnedFileLock(
    filePath: string,
    options: { timeoutMs: number; command: string },
  ): Promise<OwnedFileLock>;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40,64}$/u;
const RAW_UPSTREAM_FETCH_URL = Symbol("rawUpstreamFetchUrl");

type InspectedLocalGitState = LocalGitState & {
  [RAW_UPSTREAM_FETCH_URL]?: string;
};

export class SelfUpdateBlockedError extends Error {
  constructor(
    message: string,
    readonly plan: SelfModePlan | SelfUpdatePlan,
  ) {
    super(message);
    this.name = "SelfUpdateBlockedError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstallState(value: unknown): value is InstallState & JsonRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.checkoutRealpath === "string" &&
    (value.sourceManagementMode === "user-managed" || value.sourceManagementMode === "self-update") &&
    Number.isInteger(value.launcherProtocol) &&
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
    )
  );
}

function isBuildIdentity(value: unknown): value is BuildIdentity & JsonRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.packageVersion === "string" &&
    Number.isInteger(value.launcherProtocol) &&
    typeof value.builtAt === "string" &&
    typeof value.lockfileSha256 === "string" &&
    isRecord(value.buildInputDigest) &&
    typeof value.buildInputDigest.value === "string" &&
    typeof value.buildInputDigest.schemaVersion === "number" &&
    typeof value.buildInputDigest.algorithm === "string" &&
    (value.cliSha256 === undefined || (typeof value.cliSha256 === "string" && SHA256_RE.test(value.cliSha256))) &&
    (value.source === undefined ||
      (isRecord(value.source) &&
        (value.source.commit === undefined ||
          value.source.commit === null ||
          typeof value.source.commit === "string") &&
        (value.source.dirty === undefined || typeof value.source.dirty === "boolean")))
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryPath(paths: InstallPaths): string {
  return path.join(paths.dataRoot, "state", "self-update-recovery.json");
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read ${filePath}: ${formatError(error)}`);
  }
}

async function readPendingRecovery(paths: InstallPaths): Promise<JsonRecord | null> {
  const filePath = recoveryPath(paths);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { schemaVersion: "invalid", error: `Self-update recovery state cannot be read: ${formatError(error)}` };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch (error) {
    return { schemaVersion: "invalid", error: `Self-update recovery state is invalid JSON: ${formatError(error)}` };
  }
  return { schemaVersion: "invalid", error: "Self-update recovery state is malformed." };
}

function git(repoRoot: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function requireGit(repoRoot: string, args: readonly string[]): string {
  const result = git(repoRoot, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout;
}

function parseCounts(value: string): { ahead: number; behind: number } | null {
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== 2) return null;
  const ahead = Number.parseInt(fields[0] ?? "", 10);
  const behind = Number.parseInt(fields[1] ?? "", 10);
  return Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : null;
}

function relationFromCounts(ahead: number | null, behind: number | null): SelfUpdateRelation {
  if (ahead === null || behind === null) return "unknown";
  if (ahead === 0 && behind === 0) return "up-to-date";
  if (ahead === 0) return "behind";
  if (behind === 0) return "ahead";
  return "diverged";
}

function inspectLocalGit(repoRoot: string): InspectedLocalGitState {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const branch = git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const dirty = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (head.status !== 0 || dirty.status !== 0) {
    return {
      available: false,
      error:
        head.error?.message ??
        dirty.error?.message ??
        head.stderr ??
        dirty.stderr ??
        "Git metadata is unavailable.",
      head: null,
      branch: null,
      dirty: null,
      dirtyEntries: [],
      upstream: null,
      upstreamRemote: null,
      upstreamMergeRef: null,
      upstreamFetchUrl: null,
      cachedUpstreamCommit: null,
      cachedAhead: null,
      cachedBehind: null,
    };
  }

  const branchName = branch.status === 0 ? branch.stdout : null;
  const upstream = git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstreamName = upstream.status === 0 ? upstream.stdout : null;
  const remote = branchName ? git(repoRoot, ["config", "--get", `branch.${branchName}.remote`]) : null;
  const merge = branchName ? git(repoRoot, ["config", "--get", `branch.${branchName}.merge`]) : null;
  const remoteName = remote?.status === 0 ? remote.stdout : null;
  const remoteUrls = remoteName ? git(repoRoot, ["remote", "get-url", "--all", remoteName]) : null;
  const urlLines = remoteUrls?.status === 0 ? remoteUrls.stdout.split(/\r?\n/u).filter(Boolean) : [];
  const cachedCommit = upstreamName ? git(repoRoot, ["rev-parse", upstreamName]) : null;
  const cachedCounts =
    cachedCommit?.status === 0
      ? parseCounts(git(repoRoot, ["rev-list", "--left-right", "--count", `HEAD...${cachedCommit.stdout}`]).stdout)
      : null;
  const rawUpstreamFetchUrl = urlLines.length === 1 ? urlLines[0]! : null;
  const state: InspectedLocalGitState = {
    available: true,
    head: head.stdout,
    branch: branchName,
    dirty: dirty.stdout.length > 0,
    dirtyEntries: dirty.stdout ? dirty.stdout.split(/\r?\n/u) : [],
    upstream: upstreamName,
    upstreamRemote: remoteName,
    upstreamMergeRef: merge?.status === 0 ? merge.stdout : null,
    upstreamFetchUrl: rawUpstreamFetchUrl ? sanitizeUrlForDisplay(rawUpstreamFetchUrl) : null,
    cachedUpstreamCommit: cachedCommit?.status === 0 ? cachedCommit.stdout : null,
    cachedAhead: cachedCounts?.ahead ?? null,
    cachedBehind: cachedCounts?.behind ?? null,
  };
  if (rawUpstreamFetchUrl) {
    Object.defineProperty(state, RAW_UPSTREAM_FETCH_URL, {
      configurable: false,
      enumerable: false,
      value: rawUpstreamFetchUrl,
      writable: false,
    });
  }
  return state;
}

function rawUpstreamFetchUrl(state: LocalGitState): string | null {
  return (state as InspectedLocalGitState)[RAW_UPSTREAM_FETCH_URL] ?? state.upstreamFetchUrl;
}

function normalizedOrigin(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function officialMatch(
  policy: OfficialOriginPolicy,
  gitState: LocalGitState,
): OfficialRepositoryOrigin | null {
  if (
    policy.status !== "available" ||
    !rawUpstreamFetchUrl(gitState) ||
    !gitState.upstreamMergeRef?.startsWith("refs/heads/")
  ) {
    return null;
  }
  const branch = gitState.upstreamMergeRef.slice("refs/heads/".length);
  return (
    policy.repositories.find(
      (origin) =>
        normalizedOrigin(origin.fetchUrl) === normalizedOrigin(rawUpstreamFetchUrl(gitState)!) &&
        (!origin.branches || origin.branches.includes(branch)),
    ) ?? null
  );
}

function policyStatus(
  policy: OfficialOriginPolicy,
  match: OfficialRepositoryOrigin | null,
): OfficialPolicyStatus {
  return {
    status: policy.status,
    policyId: policy.policyId,
    ...(policy.status === "unavailable" ? { reason: policy.reason } : {}),
    matched: Boolean(match),
  };
}

async function readOwnedInstall(paths: InstallPaths): Promise<{
  owned: boolean;
  install: (InstallState & JsonRecord) | null;
  error?: string;
}> {
  let value: unknown;
  try {
    value = await readJson(paths.installStatePath);
  } catch (error) {
    return { owned: false, install: null, error: formatError(error) };
  }
  if (!isInstallState(value)) {
    return {
      owned: false,
      install: null,
      error: value === null ? "Installer ownership state is missing." : "Installer ownership state is malformed.",
    };
  }
  try {
    const [recorded, actual] = await Promise.all([
      realpath(value.checkoutRealpath),
      realpath(paths.repoRoot),
    ]);
    if (!samePath(recorded, actual)) {
      return {
        owned: false,
        install: value,
        error: `Install state belongs to ${value.checkoutRealpath}, not ${paths.repoRoot}.`,
      };
    }
  } catch (error) {
    return { owned: false, install: value, error: `Checkout ownership cannot be verified: ${formatError(error)}` };
  }
  return { owned: true, install: value };
}

async function readInstalledSource(
  paths: InstallPaths,
  head: string | null,
): Promise<{ context: InstalledSourceContext | null; blockers: string[] }> {
  const ownership = await readOwnedInstall(paths);
  const blockers: string[] = [];
  if (!ownership.owned || !ownership.install) {
    blockers.push(ownership.error ?? "The checkout is not installer-owned.");
    return { context: null, blockers };
  }
  let value: unknown;
  try {
    value = await readJson(paths.buildIdentityPath);
  } catch (error) {
    blockers.push(formatError(error));
    return { context: null, blockers };
  }
  if (!isBuildIdentity(value)) {
    blockers.push("The selected build identity is missing or malformed; run `paper-search setup --apply`.");
    return { context: null, blockers };
  }
  if (value.launcherProtocol !== ownership.install.launcherProtocol) {
    blockers.push("The selected build and install state use incompatible launcher protocols.");
  }
  const expectedInstallIdentity = {
    packageVersion: value.packageVersion,
    buildInputDigest: value.buildInputDigest,
    lockfileSha256: value.lockfileSha256,
    source: value.source ?? null,
    builtAt: value.builtAt,
  };
  if (!isDeepStrictEqual(ownership.install.buildIdentity, expectedInstallIdentity)) {
    blockers.push("Installer ownership state does not select the current verified build.");
  }
  if (!head || value.source?.commit !== head || value.source?.dirty !== false) {
    blockers.push(
      "The selected build is not a clean build of the current HEAD; run `paper-search setup --apply` before self-update.",
    );
  }
  if (value.cliSha256) {
    try {
      const actual = createHash("sha256").update(await readFile(paths.selectedCliPath)).digest("hex");
      if (actual !== value.cliSha256) blockers.push("The selected CLI bytes do not match build.json.");
    } catch (error) {
      blockers.push(`The selected CLI cannot be verified: ${formatError(error)}`);
    }
  } else {
    blockers.push("The selected build does not declare its CLI SHA-256.");
  }
  const launcherPath = path.join(paths.repoRoot, "skills", "paper-search-cli", "scripts", "paper-search.mjs");
  try {
    await access(launcherPath);
  } catch (error) {
    blockers.push(`The source-linked launcher is unavailable: ${formatError(error)}`);
  }
  return {
    context: { install: ownership.install, build: value, launcherPath },
    blockers,
  };
}

async function acquireRepoLock(
  paths: InstallPaths,
  timeoutMs: number,
  command: string,
): Promise<OwnedFileLock> {
  const modulePath = path.join(paths.repoRoot, "scripts", "lib", "owned-file-lock.mjs");
  const lockModule = (await import(pathToFileURL(modulePath).href)) as OwnedFileLockModule;
  return lockModule.acquireOwnedFileLock(
    path.join(paths.repoRoot, ".paper-search-runtime", "locks", "repo.lock"),
    { timeoutMs, command },
  );
}

function resolveRemoteTarget(repoRoot: string, state: LocalGitState): string {
  const fetchUrl = rawUpstreamFetchUrl(state);
  if (!state.upstreamRemote || !state.upstreamMergeRef || !fetchUrl) {
    throw new Error("The current branch has no configured upstream.");
  }
  // Use the policy-verified fetch URL rather than the named remote so Git does
  // not apply that remote's configured tracking refspec. Planning may add
  // objects, but it must not advance remote-tracking refs or FETCH_HEAD.
  const remote = fetchUrl;
  const mergeRef = state.upstreamMergeRef;
  const query = git(repoRoot, ["ls-remote", "--exit-code", "--heads", remote, mergeRef]);
  if (query.status !== 0) {
    throw new Error(
      `Official upstream target is unavailable at ${sanitizeUrlForDisplay(remote)} ` +
        `(git ls-remote exit ${String(query.status)}).`,
    );
  }
  const matches = query.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 2 && fields[1] === mergeRef);
  if (matches.length !== 1 || !COMMIT_RE.test(matches[0]?.[0] ?? "")) {
    throw new Error(`Official upstream did not resolve exactly one commit for ${mergeRef}.`);
  }
  const target = matches[0]![0]!;
  const fetched = git(repoRoot, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    mergeRef,
  ]);
  if (fetched.status !== 0) {
    throw new Error(
      `Official upstream objects could not be fetched from ${sanitizeUrlForDisplay(remote)} ` +
        `(git fetch exit ${String(fetched.status)}).`,
    );
  }
  const object = git(repoRoot, ["cat-file", "-e", `${target}^{commit}`]);
  if (object.status !== 0) {
    throw new Error("Official upstream moved while it was being inspected; rerun the update plan.");
  }
  return target;
}

function assertPostFastForwardState(
  repoRoot: string,
  before: LocalGitState,
  targetCommit: string,
  policy: OfficialOriginPolicy,
): void {
  const after = inspectLocalGit(repoRoot);
  const violations: string[] = [];
  if (!after.available) violations.push("Git metadata is unavailable");
  if (after.head !== targetCommit) violations.push("HEAD does not equal the verified target");
  if (after.branch !== before.branch) violations.push("the attached branch changed");
  if (after.dirty !== false) violations.push("the checkout is not clean");
  if (
    after.upstream !== before.upstream ||
    after.upstreamRemote !== before.upstreamRemote ||
    after.upstreamMergeRef !== before.upstreamMergeRef ||
    rawUpstreamFetchUrl(after) !== rawUpstreamFetchUrl(before)
  ) {
    violations.push("the configured upstream changed");
  }
  if (!officialMatch(policy, after)) violations.push("the upstream no longer matches sealed policy");
  if (violations.length > 0) {
    throw new Error(`Post-fast-forward invariants failed: ${violations.join("; ")}.`);
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; label: string },
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${options.label} failed with exit code ${String(result.status)}${detail ? `: ${detail.slice(-8_000)}` : ""}`,
    );
  }
  return result.stdout.trim();
}

async function defaultPrepareTarget(context: PreparedTargetContext): Promise<void> {
  const installerPath = path.join(context.worktreePath, "scripts", "install.mjs");
  const dataRoot = path.join(context.operationRoot, "target-install-data");
  const targetRoot = path.join(context.operationRoot, "target-skills");
  const binRoot = path.join(context.operationRoot, "target-bin");
  runProcess(
    process.execPath,
    [installerPath, "--target", targetRoot, "--bin-dir", binRoot, "--apply", "--json"],
    {
      cwd: context.worktreePath,
      env: {
        ...context.env,
        PAPER_SEARCH_INSTALL_TEST_MODE: "1",
        PAPER_SEARCH_TEST_DATA_ROOT: dataRoot,
      },
      label: "Target checkout isolated build and test",
    },
  );
}

function projectionRoots(install: InstallState): string[] {
  return [...new Set(install.projections.map((entry) => path.dirname(entry.path)))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

async function defaultApplyPreparedTarget(context: ApplyPreparedTargetContext): Promise<void> {
  const installerPath = path.join(context.repoRoot, "scripts", "install.mjs");
  const args = [installerPath];
  for (const target of projectionRoots(context.install)) args.push("--target", target);
  if (context.install.binRoot) args.push("--bin-dir", context.install.binRoot);
  args.push(
    "--apply",
    "--json",
    "--self-update-candidate",
    context.candidateDistPath,
    "--self-update-commit",
    context.targetCommit,
  );
  runProcess(process.execPath, args, {
    cwd: context.repoRoot,
    env: {
      ...context.env,
      PAPER_SEARCH_HELD_REPO_LOCK_TOKEN: context.repoLockToken,
    },
    label: "Preverified target selection and setup repair",
  });
}

async function assertCandidateBuild(candidateDistPath: string, targetCommit: string): Promise<BuildIdentity & JsonRecord> {
  const value = await readJson(path.join(candidateDistPath, "build.json"));
  if (!isBuildIdentity(value)) throw new Error("Target build did not produce a valid build.json.");
  if (value.source?.commit !== targetCommit || value.source?.dirty !== false) {
    throw new Error(`Target build is not a clean build of ${targetCommit}.`);
  }
  if (!value.cliSha256) throw new Error("Target build does not declare its CLI SHA-256.");
  const actual = createHash("sha256").update(await readFile(path.join(candidateDistPath, "cli.js"))).digest("hex");
  if (actual !== value.cliSha256) throw new Error("Target build CLI does not match build.json.");
  return value;
}

async function probeLauncherPair(
  operationRoot: string,
  label: string,
  launcherSource: string,
  distSource: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const root = path.join(operationRoot, `launcher-probe-${label}`);
  const launcherPath = path.join(root, "skills", "paper-search-cli", "scripts", "paper-search.mjs");
  await mkdir(path.dirname(launcherPath), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "package.json"), '{"name":"paper-search-cli","private":true,"type":"module"}\n', "utf8"),
    cp(launcherSource, launcherPath),
    cp(distSource, path.join(root, "dist"), { recursive: true }),
  ]);
  for (const argument of ["--version", "--help"]) {
    runProcess(process.execPath, [launcherPath, argument], {
      cwd: root,
      env: { ...env, NODE_PATH: "" },
      label: `Launcher bridge ${label} ${argument}`,
    });
  }
}

function assertOperationPath(repoRoot: string, operationRoot: string): void {
  const expectedParent = path.resolve(repoRoot, ".paper-search-runtime", "self-update");
  const actual = path.resolve(operationRoot);
  const relative = path.relative(expectedParent, actual);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe self-update operation path: ${operationRoot}`);
  }
}

async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const listed = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (listed.status === 0 && listed.stdout.includes(`worktree ${worktreePath}`)) {
    requireGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    requireGit(repoRoot, ["worktree", "prune", "--expire", "now"]);
  }
  await rm(worktreePath, { recursive: true, force: true });
}

function recoveryCommand(repoRoot: string, install: InstallState): { command: string; args: string[] } {
  const args = [path.join(repoRoot, "scripts", "install.mjs")];
  for (const target of projectionRoots(install)) args.push("--target", target);
  if (install.binRoot) args.push("--bin-dir", install.binRoot);
  args.push("--apply");
  return { command: process.execPath, args };
}

export function createSelfUpdateService(dependencies: SelfUpdateServiceDependencies) {
  const policy = dependencies.officialOriginPolicy;
  const paths = dependencies.paths ?? resolveInstallPaths(dependencies.env ?? process.env);
  const env = dependencies.env ?? process.env;
  const lockTimeoutMs = dependencies.lockTimeoutMs ?? 30_000;
  const prepareTarget = dependencies.prepareTarget ?? defaultPrepareTarget;
  const applyPreparedTarget = dependencies.applyPreparedTarget ?? defaultApplyPreparedTarget;

  async function createModePlan(after: SourceManagementMode): Promise<{
    plan: SelfModePlan;
    install: (InstallState & JsonRecord) | null;
  }> {
    const ownership = await readOwnedInstall(paths);
    const gitState = inspectLocalGit(paths.repoRoot);
    const match = officialMatch(policy, gitState);
    const blockers: string[] = [];
    if (!ownership.owned || !ownership.install) {
      blockers.push(ownership.error ?? "The checkout is not installer-owned.");
    }
    if (after === "self-update") {
      if (policy.status === "unavailable") blockers.push(policy.reason);
      if (!gitState.available) blockers.push(gitState.error ?? "Git metadata is unavailable.");
      if (!gitState.branch) blockers.push("Self-update requires an attached local branch.");
      if (gitState.dirty !== false) blockers.push("Self-update opt-in requires a clean checkout.");
      if (!gitState.upstream || !gitState.upstreamRemote || !gitState.upstreamMergeRef) {
        blockers.push("Self-update opt-in requires a configured branch upstream.");
      }
      if (policy.status === "available" && !match) {
        blockers.push("The configured upstream does not match the sealed official origin policy.");
      }
    }
    const base = {
      schemaVersion: 1 as const,
      operation: "mode" as const,
      repoRoot: paths.repoRoot,
      before: ownership.install?.sourceManagementMode ?? null,
      after,
      installerOwned: ownership.owned,
      clean: gitState.dirty === null ? null : !gitState.dirty,
      officialPolicy: policyStatus(policy, match),
      upstream: gitState.upstream,
      upstreamFetchUrl: gitState.upstreamFetchUrl,
      actions:
        ownership.install?.sourceManagementMode === after
          ? []
          : [`Persist sourceManagementMode=${after} in installer ownership state.`],
      blockers: [...new Set(blockers)],
    };
    return {
      plan: { ...base, blocked: base.blockers.length > 0, planDigest: hashPlan(base) },
      install: ownership.install,
    };
  }

  async function planMode(after: SourceManagementMode): Promise<SelfModePlan> {
    return (await createModePlan(after)).plan;
  }

  async function executeMode(
    after: SourceManagementMode,
    apply: boolean,
  ): Promise<SelfMutationResult<SelfModePlan>> {
    const initial = await createModePlan(after);
    if (!apply) return { plan: initial.plan, applied: false };
    if (initial.plan.blocked) {
      throw new SelfUpdateBlockedError("Source-management mode change is blocked.", initial.plan);
    }
    if (initial.plan.actions.length === 0) return { plan: initial.plan, applied: false };

    const repoLock = await acquireRepoLock(paths, lockTimeoutMs, "self mode");
    const operationId = randomUUID();
    let committedPlan: SelfModePlan;
    try {
      const setupLock = await acquireLock("setup", {
        env,
        lockRoot: path.join(paths.dataRoot, "state", "locks"),
        timeoutMs: lockTimeoutMs,
        command: "self mode",
      });
      try {
        const current = await createModePlan(after);
        if (current.plan.planDigest !== initial.plan.planDigest) {
          throw new Error("Source-management mode plan changed before apply; rerun the plan.");
        }
        if (current.plan.blocked || !current.install) {
          throw new SelfUpdateBlockedError("Source-management mode change is blocked.", current.plan);
        }
        await atomicWriteConfigFile(
          paths.installStatePath,
          `${JSON.stringify(
            { ...current.install, sourceManagementMode: after, updatedAt: new Date().toISOString() },
            null,
            2,
          )}\n`,
          0o600,
        );
        committedPlan = current.plan;
      } finally {
        await setupLock.release();
      }
    } finally {
      await repoLock.release();
    }
    const audit = await tryAppendLifecycleEvent(
      {
        operationId,
        command: "self mode",
        planDigest: committedPlan!.planDigest,
        affectedIds: [],
        outcome: "applied",
      },
      env,
    );
    return {
      plan: committedPlan!,
      applied: true,
      operationId,
      ...(audit.warning ? { auditWarnings: [audit.warning] } : {}),
    };
  }

  async function createUpdatePlan(): Promise<{
    plan: SelfUpdatePlan;
    installed: InstalledSourceContext | null;
  }> {
    const gitState = inspectLocalGit(paths.repoRoot);
    const ownership = await readOwnedInstall(paths);
    const match = officialMatch(policy, gitState);
    const pendingRecovery = await readPendingRecovery(paths);
    const blockers: string[] = [];
    if (policy.status === "unavailable") blockers.push(policy.reason);
    if (!ownership.owned || !ownership.install) {
      blockers.push(ownership.error ?? "The checkout is not installer-owned.");
    } else if (ownership.install.sourceManagementMode !== "self-update") {
      blockers.push("Self-update is not enabled; review `paper-search self mode self-update` first.");
    }
    if (!gitState.available) blockers.push(gitState.error ?? "Git metadata is unavailable.");
    if (!gitState.branch) blockers.push("Self-update requires an attached local branch.");
    if (gitState.dirty !== false) blockers.push("Self-update requires a clean checkout.");
    if (!gitState.upstream || !gitState.upstreamRemote || !gitState.upstreamMergeRef) {
      blockers.push("Self-update requires a configured branch upstream.");
    }
    if (policy.status === "available" && !match) {
      blockers.push("The configured upstream does not match the sealed official origin policy.");
    }
    if (pendingRecovery) {
      blockers.push(`A prior self-update requires recovery: ${recoveryPath(paths)}`);
    }
    const installed = await readInstalledSource(paths, gitState.head);
    blockers.push(...installed.blockers);
    const setupJournalPath = path.join(paths.dataRoot, "state", "setup-journal.json");
    try {
      if ((await readJson(setupJournalPath)) !== null) {
        blockers.push(`An interrupted setup must be recovered before self-update: ${setupJournalPath}`);
      }
    } catch (error) {
      blockers.push(`Setup recovery state cannot be verified: ${formatError(error)}`);
    }

    let targetCommit: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (
      policy.status === "available" &&
      match &&
      gitState.available &&
      gitState.head &&
      gitState.upstreamRemote &&
      gitState.upstreamMergeRef
    ) {
      try {
        targetCommit = resolveRemoteTarget(paths.repoRoot, gitState);
        const counts = parseCounts(requireGit(paths.repoRoot, [
          "rev-list",
          "--left-right",
          "--count",
          `HEAD...${targetCommit}`,
        ]));
        if (!counts) throw new Error("Git returned an invalid ahead/behind count.");
        ({ ahead, behind } = counts);
        if (ahead > 0 && behind === 0) blockers.push("The checkout has local-only commits.");
        if (ahead > 0 && behind > 0) blockers.push("The checkout and official upstream have diverged.");
        const ancestor = git(paths.repoRoot, ["merge-base", "--is-ancestor", "HEAD", targetCommit]);
        if (behind > 0 && ancestor.status !== 0) {
          blockers.push("The official target is not a fast-forward descendant of HEAD.");
        }
      } catch (error) {
        blockers.push(formatError(error));
      }
    }
    const relation = relationFromCounts(ahead, behind);
    const actions =
      relation === "behind" && targetCommit
        ? [
            `Build and test ${targetCommit} in a temporary worktree.`,
            "Verify both launcher/current-target bundle pairings.",
            `Advance the canonical checkout to ${targetCommit} with git merge --ff-only.`,
            "Select the preverified dist through the retained-checkout installer.",
          ]
        : [];
    const base = {
      schemaVersion: 1 as const,
      operation: "update" as const,
      repoRoot: paths.repoRoot,
      sourceManagementMode: ownership.install?.sourceManagementMode ?? null,
      installerOwned: ownership.owned,
      officialPolicy: policyStatus(policy, match),
      git: gitState,
      targetCommit,
      ahead,
      behind,
      relation,
      currentBuildCommit: installed.context?.build.source?.commit ?? null,
      pendingRecoveryPath: pendingRecovery ? recoveryPath(paths) : null,
      actions,
      blockers: [...new Set(blockers)],
    };
    return {
      plan: { ...base, blocked: base.blockers.length > 0, planDigest: hashPlan(base) },
      installed: installed.context,
    };
  }

  async function planUpdate(): Promise<SelfUpdatePlan> {
    if (policy.status === "unavailable") return (await createUpdatePlan()).plan;
    const repoLock = await acquireRepoLock(paths, lockTimeoutMs, "self update");
    try {
      return (await createUpdatePlan()).plan;
    } finally {
      await repoLock.release();
    }
  }

  async function executeUpdate(apply: boolean): Promise<SelfMutationResult<SelfUpdatePlan>> {
    if (!apply) return { plan: await planUpdate(), applied: false };
    const repoLock = await acquireRepoLock(paths, lockTimeoutMs, "self update");
    let committedPlan: SelfUpdatePlan | null = null;
    let operationId: string | undefined;
    let postFastForwardError: Error | null = null;
    try {
      const initial = await createUpdatePlan();
      if (initial.plan.blocked || !initial.installed) {
        throw new SelfUpdateBlockedError("Self-update is blocked.", initial.plan);
      }
      if (initial.plan.relation === "up-to-date") return { plan: initial.plan, applied: false };
      if (initial.plan.relation !== "behind" || !initial.plan.targetCommit) {
        throw new SelfUpdateBlockedError("Self-update has no fast-forward target.", initial.plan);
      }

      operationId = randomUUID();
      const operationRoot = path.join(
        paths.repoRoot,
        ".paper-search-runtime",
        "self-update",
        operationId,
      );
      assertOperationPath(paths.repoRoot, operationRoot);
      const worktreePath = path.join(operationRoot, "worktree");
      const candidateDistPath = path.join(operationRoot, "candidate-dist");
      await mkdir(operationRoot, { recursive: true });
      let worktreeAdded = false;
      try {
        requireGit(paths.repoRoot, ["worktree", "add", "--detach", worktreePath, initial.plan.targetCommit]);
        worktreeAdded = true;
        await prepareTarget({
          repoRoot: paths.repoRoot,
          worktreePath,
          targetCommit: initial.plan.targetCommit,
          operationRoot,
          env,
        });
        await assertCandidateBuild(path.join(worktreePath, "dist"), initial.plan.targetCommit);
        await cp(path.join(worktreePath, "dist"), candidateDistPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const targetBuild = await assertCandidateBuild(candidateDistPath, initial.plan.targetCommit);
        const targetLauncher = path.join(
          worktreePath,
          "skills",
          "paper-search-cli",
          "scripts",
          "paper-search.mjs",
        );
        await probeLauncherPair(
          operationRoot,
          "target-launcher-current-bundle",
          targetLauncher,
          path.dirname(paths.buildIdentityPath),
          env,
        );
        await probeLauncherPair(
          operationRoot,
          "current-launcher-target-bundle",
          initial.installed.launcherPath,
          candidateDistPath,
          env,
        );
        if (!Number.isInteger(targetBuild.launcherProtocol)) {
          throw new Error("Target launcher protocol is invalid.");
        }
        await cleanupWorktree(paths.repoRoot, worktreePath);
        worktreeAdded = false;

        const finalPlan = await createUpdatePlan();
        if (finalPlan.plan.planDigest !== initial.plan.planDigest) {
          throw new Error("Self-update inputs changed during target verification; rerun the plan.");
        }
        const merge = git(paths.repoRoot, ["merge", "--ff-only", initial.plan.targetCommit]);
        const headAfterMerge = requireGit(paths.repoRoot, ["rev-parse", "HEAD"]);
        const canonicalAdvanced = headAfterMerge === initial.plan.targetCommit;
        if (merge.status !== 0 && !canonicalAdvanced) {
          throw new Error(
            `git merge --ff-only failed before advancing HEAD: ${
              merge.error?.message ?? merge.stderr ?? merge.stdout
            }`,
          );
        }
        if (!canonicalAdvanced) {
          throw new Error("git merge --ff-only returned without selecting the verified target commit.");
        }
        const recovery = {
          schemaVersion: 1,
          operationId,
          phase: "canonical-advanced",
          previousCommit: initial.plan.git.head,
          targetCommit: initial.plan.targetCommit,
          candidateDistPath,
          selectedDistPath: path.join(paths.repoRoot, "dist"),
          priorDistPath: path.join(paths.repoRoot, "dist.previous"),
          installStatePath: paths.installStatePath,
          recovery: recoveryCommand(paths.repoRoot, initial.installed.install),
          updatedAt: new Date().toISOString(),
        };
        try {
          await atomicWriteConfigFile(recoveryPath(paths), `${JSON.stringify(recovery, null, 2)}\n`, 0o600);
          assertPostFastForwardState(
            paths.repoRoot,
            initial.plan.git,
            initial.plan.targetCommit,
            policy,
          );
          await applyPreparedTarget({
            repoRoot: paths.repoRoot,
            targetCommit: initial.plan.targetCommit,
            candidateDistPath,
            install: initial.installed.install,
            repoLockToken: repoLock.token,
            env,
          });
          const after = await readOwnedInstall(paths);
          const installedCommit = isRecord(after.install?.buildIdentity)
            ? (after.install.buildIdentity.source as JsonRecord | undefined)?.commit
            : undefined;
          if (
            !after.owned ||
            after.install?.sourceManagementMode !== "self-update" ||
            installedCommit !== initial.plan.targetCommit
          ) {
            throw new Error("Installer state did not select the verified target build.");
          }
          await rm(recoveryPath(paths), { force: true });
          await rm(operationRoot, { recursive: true, force: true });
          committedPlan = initial.plan;
        } catch (error) {
          const failure = {
            ...recovery,
            phase: "post-fast-forward-failed",
            error: formatError(error),
            updatedAt: new Date().toISOString(),
          };
          let recoveryWriteError: unknown;
          try {
            await atomicWriteConfigFile(recoveryPath(paths), `${JSON.stringify(failure, null, 2)}\n`, 0o600);
          } catch (writeError) {
            recoveryWriteError = writeError;
          }
          postFastForwardError = new Error(
            `The canonical checkout advanced to ${initial.plan.targetCommit}, but target selection failed. ` +
              `The prior runtime remains at ${failure.priorDistPath} when a swap occurred. ` +
              (recoveryWriteError
                ? `Recovery state could not be persisted at ${recoveryPath(paths)}: ${formatError(recoveryWriteError)}. `
                : `Recovery state: ${recoveryPath(paths)}. Run the recorded setup recovery command. `) +
              `Cause: ${formatError(error)}`,
          );
        }
      } finally {
        if (worktreeAdded) await cleanupWorktree(paths.repoRoot, worktreePath).catch(() => undefined);
        if (!postFastForwardError && !committedPlan) {
          await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } finally {
      await repoLock.release();
    }
    if (postFastForwardError) throw postFastForwardError;
    if (!committedPlan || !operationId) throw new Error("Self-update did not produce a committed result.");
    const audit = await tryAppendLifecycleEvent(
      {
        operationId,
        command: "self update",
        planDigest: committedPlan.planDigest,
        affectedIds: [],
        outcome: "applied",
      },
      env,
    );
    return {
      plan: committedPlan,
      applied: true,
      operationId,
      ...(audit.warning ? { auditWarnings: [audit.warning] } : {}),
    };
  }

  async function inspectStatus(): Promise<SelfCheckoutStatus> {
    const ownership = await readOwnedInstall(paths);
    const gitState = inspectLocalGit(paths.repoRoot);
    const match = officialMatch(policy, gitState);
    return {
      sourceManagementMode: ownership.install?.sourceManagementMode ?? null,
      installerOwned: ownership.owned,
      officialPolicy: policyStatus(policy, match),
      git: gitState,
      pendingRecovery: await readPendingRecovery(paths),
      pendingRecoveryPath: recoveryPath(paths),
    };
  }

  return {
    paths,
    inspectStatus,
    planMode,
    executeMode,
    planUpdate,
    executeUpdate,
  };
}
