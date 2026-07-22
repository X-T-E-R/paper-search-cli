import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeForPersistence } from "../../runtime/sanitizeUrl.js";

export const PROVIDER_RECEIPT_FILENAME = ".paper-search-receipt.json";

export type ProviderRuntimeKind = "search" | "material";

export interface ProviderReplacementPrecondition {
  state: "absent" | "present";
  digest?: string;
}

export interface ManualZipInstallPlan {
  schemaVersion: 1;
  installType: "manual-zip";
  bound: false;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  archivePath: string;
  archiveSha256: string;
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
  installDir: string;
  targetPath: string;
  receiptPath: string;
  replacementPrecondition: ProviderReplacementPrecondition;
  currentVersion: string;
}

export interface ProviderInstallReceipt {
  schemaVersion: 1;
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  installType: "registry" | "manual-zip" | "legacy-directory";
  bound: boolean;
  archiveSha256?: string;
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
  installedAt: string;
  updatedAt: string;
  subscriptionId?: string;
  sourceFingerprint?: string;
  canonicalSource?: string;
  registryDigest?: string;
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function appendPathState(
  hash: ReturnType<typeof createHash>,
  root: string,
  currentPath: string,
  ignoredRelativePaths: ReadonlySet<string>,
): Promise<void> {
  const info = await lstat(currentPath);
  const relativePath = path.relative(root, currentPath).replace(/\\/g, "/") || ".";
  if (ignoredRelativePaths.has(relativePath)) return;
  if (info.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    const entries = await readdir(currentPath);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await appendPathState(hash, root, path.join(currentPath, entry), ignoredRelativePaths);
    }
    return;
  }
  if (info.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(await readFile(currentPath));
    hash.update("\0");
    return;
  }
  if (info.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${await readlink(currentPath)}\0`);
    return;
  }
  hash.update(`other\0${relativePath}\0${info.mode}\0${info.size}\0`);
}

export async function inspectProviderReplacementPrecondition(
  targetPath: string,
): Promise<ProviderReplacementPrecondition> {
  return inspectProviderReplacementPreconditionIgnoring(targetPath, new Set());
}

async function inspectProviderReplacementPreconditionIgnoring(
  targetPath: string,
  ignoredRelativePaths: ReadonlySet<string>,
): Promise<ProviderReplacementPrecondition> {
  const resolvedTarget = path.resolve(targetPath);
  try {
    await lstat(resolvedTarget);
  } catch (error) {
    if (isMissing(error)) return { state: "absent" };
    throw error;
  }

  const hash = createHash("sha256");
  hash.update("paper-search-provider-target-v1\0");
  await appendPathState(hash, resolvedTarget, resolvedTarget, ignoredRelativePaths);
  return { state: "present", digest: hash.digest("hex") };
}

/** Digest a selected migration target as if its generated receipt were absent. */
export async function inspectProviderPreconditionWithoutReceipt(
  targetPath: string,
): Promise<ProviderReplacementPrecondition> {
  return inspectProviderReplacementPreconditionIgnoring(
    targetPath,
    new Set([PROVIDER_RECEIPT_FILENAME]),
  );
}

export async function assertProviderReplacementPrecondition(
  targetPath: string,
  expected: ProviderReplacementPrecondition,
): Promise<void> {
  const actual = await inspectProviderReplacementPrecondition(targetPath);
  if (actual.state !== expected.state || actual.digest !== expected.digest) {
    throw new Error(`Provider install target changed after planning: ${path.resolve(targetPath)}`);
  }
}

export async function readPreviousInstalledAt(receiptPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { installedAt?: unknown };
    return typeof parsed.installedAt === "string" && parsed.installedAt.length > 0
      ? parsed.installedAt
      : undefined;
  } catch {
    return undefined;
  }
}

export async function createManualZipReceipt(
  plan: ManualZipInstallPlan,
): Promise<ProviderInstallReceipt> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runtimeKind: plan.runtimeKind,
    providerKind: plan.providerKind,
    id: plan.id,
    version: plan.version,
    installType: "manual-zip",
    bound: false,
    archiveSha256: plan.archiveSha256,
    manifestSha256: plan.manifestSha256,
    entryPath: plan.entryPath,
    entrySha256: plan.entrySha256,
    installedAt: (plan.replacementPrecondition.state === "present"
      ? await readPreviousInstalledAt(plan.receiptPath)
      : undefined) ?? now,
    updatedAt: now,
  };
}

export function parseProviderInstallReceipt(raw: string, receiptPath = "provider receipt"): ProviderInstallReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${receiptPath}`, { cause: error });
  }
  const receipt = value as Partial<ProviderInstallReceipt>;
  const digest = (candidate: unknown) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  if (
    receipt.schemaVersion !== 1 ||
    (receipt.runtimeKind !== "search" && receipt.runtimeKind !== "material") ||
    typeof receipt.providerKind !== "string" ||
    typeof receipt.id !== "string" ||
    typeof receipt.version !== "string" ||
    !["registry", "manual-zip", "legacy-directory"].includes(receipt.installType ?? "") ||
    typeof receipt.bound !== "boolean" ||
    !digest(receipt.manifestSha256) ||
    typeof receipt.entryPath !== "string" ||
    !digest(receipt.entrySha256) ||
    typeof receipt.installedAt !== "string" ||
    typeof receipt.updatedAt !== "string" ||
    (receipt.archiveSha256 !== undefined && !digest(receipt.archiveSha256))
  ) {
    throw new Error(`Invalid provider receipt: ${receiptPath}`);
  }
  if (receipt.installType !== "legacy-directory" && !digest(receipt.archiveSha256)) {
    throw new Error(`Provider receipt requires archiveSha256: ${receiptPath}`);
  }
  if (receipt.bound) {
    if (
      receipt.installType !== "registry" ||
      typeof receipt.subscriptionId !== "string" ||
      !digest(receipt.sourceFingerprint) ||
      typeof receipt.canonicalSource !== "string" ||
      !digest(receipt.registryDigest)
    ) {
      throw new Error(`Invalid bound provider receipt: ${receiptPath}`);
    }
  }
  return receipt as ProviderInstallReceipt;
}

export async function readProviderInstallReceipt(
  providerPath: string,
): Promise<ProviderInstallReceipt | null> {
  const receiptPath = path.join(providerPath, PROVIDER_RECEIPT_FILENAME);
  try {
    return parseProviderInstallReceipt(await readFile(receiptPath, "utf8"), receiptPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function stageProviderReceipt(
  stagingPath: string,
  receipt: ProviderInstallReceipt,
): Promise<void> {
  await writeFile(
    path.join(stagingPath, PROVIDER_RECEIPT_FILENAME),
    `${JSON.stringify(sanitizeForPersistence(receipt), null, 2)}\n`,
    "utf8",
  );
}
