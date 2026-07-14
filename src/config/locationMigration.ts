import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperSearchPaths } from "./home.js";
import { expandHome } from "./paths.js";
import { applyCredentialPermissions } from "./permissions.js";
import { applyConfigTransaction } from "./transactions.js";
import { atomicWriteConfigFile, digestConfigContent } from "./userConfig.js";

const ROOT_FILES = new Set([
  "config.toml",
  "subscriptions.toml",
  "credentials.toml",
  "external-search.toml",
]);
const EXECUTABLE_EXTENSION = /\.(?:bat|cmd|com|dll|exe|js|cjs|mjs|ps1|sh)$/iu;

export type LegacyConfigOrigin = "windows-appdata" | "xdg" | "home-config" | "explicit";

export interface LegacyConfigFile {
  relativePath: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  credential: boolean;
}

export interface LegacyConfigCandidate {
  root: string;
  origins: LegacyConfigOrigin[];
  nonEmpty: boolean;
  fingerprint: string | null;
  files: LegacyConfigFile[];
  ignored: string[];
  blockers: string[];
}

export interface ConfigLocationMigrationEntry extends LegacyConfigFile {
  destination: string;
  action: "copy" | "identical" | "conflict";
  destinationSha256?: string;
}

export interface ConfigLocationMigrationPlan {
  schemaVersion: 1;
  home: string;
  destinationRoot: string;
  receiptPath: string;
  status: "none" | "pending" | "ambiguous" | "conflicted" | "blocked" | "completed" | "ignored-legacy";
  selectedSource: string | null;
  candidates: LegacyConfigCandidate[];
  entries: ConfigLocationMigrationEntry[];
  blockers: string[];
  requiresExplicitSource: boolean;
  destinationBundlePresent: boolean;
  receiptPresent: boolean;
  planDigest: string;
}

export interface ApplyConfigLocationMigrationResult {
  plan: ConfigLocationMigrationPlan;
  applied: boolean;
  changed: boolean;
  operationId?: string;
  receiptPath?: string;
}

function comparable(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function optionalBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function inspectKnownFile(
  root: string,
  relativePath: string,
  blockers: string[],
): Promise<LegacyConfigFile | null> {
  const filePath = path.join(root, relativePath);
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    blockers.push(`${filePath}: migration source must be a regular file and cannot be a symlink`);
    return null;
  }
  const bytes = await readFile(filePath);
  return {
    relativePath: relativePath.split(path.sep).join("/"),
    path: filePath,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    credential: relativePath === "credentials.toml",
  };
}

async function inspectKnownDirectory(
  root: string,
  name: "config.d" | "adapters",
  files: LegacyConfigFile[],
  ignored: string[],
  blockers: string[],
): Promise<void> {
  const directory = path.join(root, name);
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    blockers.push(`${directory}: migration source must be a real directory and cannot be a symlink`);
    return;
  }
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.join(name, entry.name);
    const filePath = path.join(root, relativePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      blockers.push(`${filePath}: nested directories and symlinks are not accepted in legacy ${name}`);
      continue;
    }
    const accepted = name === "config.d" ? entry.name.endsWith(".toml") : entry.name.endsWith(".mjs");
    if (!accepted) {
      if (EXECUTABLE_EXTENSION.test(entry.name)) {
        blockers.push(`${filePath}: unknown executable file is not eligible for migration`);
      } else {
        ignored.push(relativePath.split(path.sep).join("/"));
      }
      continue;
    }
    const file = await inspectKnownFile(root, relativePath, blockers);
    if (file) files.push(file);
  }
}

async function inspectCandidate(
  root: string,
  origins: LegacyConfigOrigin[],
): Promise<LegacyConfigCandidate> {
  const files: LegacyConfigFile[] = [];
  const ignored: string[] = [];
  const blockers: string[] = [];
  let entries;
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        root,
        origins,
        nonEmpty: true,
        fingerprint: null,
        files,
        ignored,
        blockers: [`${root}: legacy root must be a real directory and cannot be a symlink`],
      };
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { root, origins, nonEmpty: false, fingerprint: null, files, ignored, blockers };
    }
    throw error;
  }

  for (const name of [...ROOT_FILES].sort()) {
    const file = await inspectKnownFile(root, name, blockers);
    if (file) files.push(file);
  }
  await inspectKnownDirectory(root, "config.d", files, ignored, blockers);
  await inspectKnownDirectory(root, "adapters", files, ignored, blockers);

  for (const entry of entries) {
    if (ROOT_FILES.has(entry.name) || entry.name === "config.d" || entry.name === "adapters") continue;
    if (entry.isFile() && EXECUTABLE_EXTENSION.test(entry.name)) {
      blockers.push(`${path.join(root, entry.name)}: unknown executable file is not eligible for migration`);
    } else {
      ignored.push(entry.name);
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const fingerprint = files.length > 0
    ? sha256(files.map((file) => `${file.relativePath}\0${file.sha256}`).join("\n"))
    : null;
  return {
    root,
    origins,
    nonEmpty: files.length > 0 || blockers.length > 0,
    fingerprint,
    files,
    ignored: [...new Set(ignored)].sort(),
    blockers: [...new Set(blockers)].sort(),
  };
}

export function legacyConfigRootCandidates(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): Array<{ root: string; origin: LegacyConfigOrigin }> {
  const candidates: Array<{ root: string; origin: LegacyConfigOrigin }> = [];
  const appData = env.APPDATA?.trim();
  if (appData) candidates.push({ root: path.join(appData, "paper-search"), origin: "windows-appdata" });
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) candidates.push({ root: path.join(expandHome(xdg), "paper-search"), origin: "xdg" });
  candidates.push({ root: path.join(userHome, ".config", "paper-search"), origin: "home-config" });
  return candidates;
}

async function destinationBundlePresent(destinationRoot: string): Promise<boolean> {
  for (const name of [...ROOT_FILES, "config.d", "adapters"]) {
    try {
      await lstat(path.join(destinationRoot, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function receiptPresent(receiptPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(receiptPath, "utf8")) as { schemaVersion?: unknown; status?: unknown };
    return value.schemaVersion === 1 && value.status === "complete";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

export async function planConfigLocationMigration(options: {
  env?: NodeJS.ProcessEnv;
  legacyConfigRoot?: string;
  userHome?: string;
} = {}): Promise<ConfigLocationMigrationPlan> {
  const env = options.env ?? process.env;
  const paths = resolvePaperSearchPaths(env, options.userHome);
  const grouped = new Map<string, { root: string; origins: LegacyConfigOrigin[] }>();
  for (const candidate of legacyConfigRootCandidates(env, options.userHome)) {
    if (comparable(candidate.root) === comparable(paths.home)) continue;
    const key = comparable(candidate.root);
    const current = grouped.get(key);
    if (current) current.origins.push(candidate.origin);
    else grouped.set(key, { root: path.resolve(candidate.root), origins: [candidate.origin] });
  }
  if (options.legacyConfigRoot) {
    const explicit = path.resolve(options.legacyConfigRoot);
    const key = comparable(explicit);
    const current = grouped.get(key);
    if (current) current.origins.unshift("explicit");
    else grouped.set(key, { root: explicit, origins: ["explicit"] });
  }
  const candidates = await Promise.all([...grouped.values()].map((candidate) => inspectCandidate(candidate.root, candidate.origins)));
  candidates.sort((left, right) => left.root.localeCompare(right.root));
  const nonEmpty = candidates.filter((candidate) => candidate.nonEmpty);
  const destinationPresent = await destinationBundlePresent(paths.home);
  const receiptPath = path.join(paths.stateRoot, "migrations", "config-location-v1.json");
  const hasReceipt = await receiptPresent(receiptPath);
  const explicit = options.legacyConfigRoot
    ? candidates.find((candidate) => comparable(candidate.root) === comparable(options.legacyConfigRoot!)) ?? null
    : null;
  const distinctFingerprints = new Set(nonEmpty.map((candidate) => candidate.fingerprint ?? `blocked:${candidate.root}`));
  const requiresExplicitSource = !explicit && nonEmpty.length > 1 && distinctFingerprints.size > 1;
  const selected = explicit ?? (requiresExplicitSource ? null : nonEmpty[0] ?? null);
  const entries: ConfigLocationMigrationEntry[] = [];
  const blockers = [...(selected?.blockers ?? [])];

  // A destination entry is not a migration completion marker.  In particular,
  // a process can stop after copying its first file, so always compare the
  // selected source with every known destination entry until a receipt exists.
  if (selected) {
    for (const file of selected.files) {
      const destination = path.join(paths.home, ...file.relativePath.split("/"));
      const bytes = await optionalBytes(destination);
      const destinationSha256 = bytes ? sha256(bytes) : undefined;
      entries.push({
        ...file,
        destination,
        action: !bytes ? "copy" : destinationSha256 === file.sha256 ? "identical" : "conflict",
        ...(destinationSha256 ? { destinationSha256 } : {}),
      });
    }
  }
  if (entries.some((entry) => entry.action === "conflict")) {
    blockers.push(...entries.filter((entry) => entry.action === "conflict").map((entry) => `Destination conflict: ${entry.destination}`));
  }

  let status: ConfigLocationMigrationPlan["status"];
  if (requiresExplicitSource) status = "ambiguous";
  else if (!selected) status = "none";
  else if (blockers.length > 0 && entries.some((entry) => entry.action === "conflict")) status = "conflicted";
  else if (blockers.length > 0) status = "blocked";
  else if (entries.every((entry) => entry.action === "identical") && hasReceipt) status = "completed";
  else status = "pending";

  const base = {
    schemaVersion: 1 as const,
    home: paths.home,
    destinationRoot: paths.home,
    receiptPath,
    status,
    selectedSource: selected?.root ?? null,
    candidates,
    entries,
    blockers: [...new Set(blockers)].sort(),
    requiresExplicitSource,
    destinationBundlePresent: destinationPresent,
    receiptPresent: hasReceipt,
  };
  return { ...base, planDigest: sha256(JSON.stringify(base)) };
}

export async function applyConfigLocationMigration(options: {
  env?: NodeJS.ProcessEnv;
  legacyConfigRoot?: string;
  userHome?: string;
  /** Test-only interruption seam; production callers leave this undefined. */
  onChangeApplied?: (filePath: string) => Promise<void> | void;
} = {}): Promise<ApplyConfigLocationMigrationResult> {
  const env = options.env ?? process.env;
  const plan = await planConfigLocationMigration(options);
  if (["none", "completed", "ignored-legacy"].includes(plan.status)) {
    return { plan, applied: true, changed: false, ...(plan.receiptPresent ? { receiptPath: plan.receiptPath } : {}) };
  }
  if (plan.status !== "pending" || !plan.selectedSource) {
    return { plan, applied: false, changed: false };
  }

  for (const entry of plan.entries) {
    const current = await optionalBytes(entry.path);
    if (!current || sha256(current) !== entry.sha256) {
      throw new Error(`Legacy config source changed after planning: ${entry.path}`);
    }
  }
  // Include already-identical paths in the transaction.  A retry may observe
  // the first copied file as identical while its pending journal still owns
  // that path; excluding it would make safe journal recovery impossible.
  const changes = await Promise.all(plan.entries.map(async (entry) => ({
    path: entry.destination,
    expectedDigest: digestConfigContent(""),
    content: (await readFile(entry.path)).toString("utf8"),
    ...(entry.credential ? { mode: 0o600 } : {}),
  })));
  let operationId: string | undefined;
  if (changes.length > 0) {
    const transaction = await applyConfigTransaction({
      command: "migrate config-location",
      planDigest: plan.planDigest,
      changes,
      env,
      onChangeApplied: options.onChangeApplied,
    });
    operationId = transaction.operationId;
  }

  const receipt = {
    schemaVersion: 1,
    status: "complete",
    sourceRoot: plan.selectedSource,
    destinationRoot: plan.destinationRoot,
    sourceFingerprint: plan.candidates.find((candidate) => comparable(candidate.root) === comparable(plan.selectedSource!))?.fingerprint ?? null,
    planDigest: plan.planDigest,
    operationId: operationId ?? null,
    copied: plan.entries.filter((entry) => entry.action === "copy").map((entry) => ({
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
    })),
    identical: plan.entries.filter((entry) => entry.action === "identical").map((entry) => entry.relativePath),
    completedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(plan.receiptPath), { recursive: true, mode: 0o700 });
  await atomicWriteConfigFile(plan.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  await applyCredentialPermissions(plan.receiptPath);
  const finalPlan = await planConfigLocationMigration(options);
  return {
    plan: finalPlan,
    applied: true,
    changed: changes.some((_, index) => plan.entries[index]?.action === "copy") || !plan.receiptPresent,
    ...(operationId ? { operationId } : {}),
    receiptPath: plan.receiptPath,
  };
}

export class ConfigLocationMigrationRequiredError extends Error {
  readonly code = "config_location_migration_required";
  constructor(readonly plan: ConfigLocationMigrationPlan) {
    super(
      `config_location_migration_required: legacy configuration exists at ${plan.selectedSource ?? "multiple roots"}; run \`paper-search migrate\` to inspect the copy-only migration plan`,
    );
    this.name = "ConfigLocationMigrationRequiredError";
  }
}
