import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { parseMaterialProviderManifest } from "../manifest.js";
import { loadMaterialProviderPackage } from "../package/load.js";
import type { MaterialProviderManifest } from "../types.js";
import {
  assertSafeRelativePath as assertSharedSafeRelativePath,
  resolveSafePathInsideRoot,
} from "../../runtime/safeRelativePath.js";
import { replaceInstallPath } from "../../providers/install/replace.js";
import {
  assertProviderReplacementPrecondition,
  createManualZipReceipt,
  inspectProviderReplacementPrecondition,
  PROVIDER_RECEIPT_FILENAME,
  readPreviousInstalledAt,
  sha256Bytes,
  stageProviderReceipt,
  type ManualZipInstallPlan,
  type ProviderInstallReceipt,
} from "../../providers/install/manualZip.js";
import type { InstallPathReplacementOperations } from "../../providers/install/replace.js";
import { getSystemVersion, semverGte } from "../../runtime/version.js";

export class MaterialProviderInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialProviderInstallError";
  }
}

export interface MaterialProviderInstallExpectation {
  id?: string;
  version?: string;
  kind?: MaterialProviderManifest["kind"];
  currentVersion?: string;
  /**
   * Registry checksum semantics:
   * - "archive": sha256 is calculated over the original zip bytes.
   * - "entry": sha256 is calculated over the provider entrypoint bytes.
   *
   * Directory packages do not have stable archive bytes, so registry checksums
   * for packagePath installs use "entry". Zip installs use "archive" by
   * default so the registry pins the exact distribution artifact.
   */
  registryChecksum?: {
    sha256: string;
    target: "archive" | "entry";
  };
}

export interface InstallMaterialProviderResult {
  id: string;
  manifest: MaterialProviderManifest;
  installPath: string;
  replacedExisting: boolean;
}

export interface MaterialProviderZipInstallPlan extends ManualZipInstallPlan {
  runtimeKind: "material";
  providerKind: MaterialProviderManifest["kind"];
}

export interface AppliedMaterialProviderZipInstall extends InstallMaterialProviderResult {
  plan: MaterialProviderZipInstallPlan;
  receipt: ProviderInstallReceipt;
}

export interface InspectedMaterialProviderZip {
  id: string;
  version: string;
  providerKind: MaterialProviderManifest["kind"];
  archiveSha256: string;
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
  manifest: MaterialProviderManifest;
}

interface MaterializedFile {
  relativePath: string;
  bytes: Uint8Array;
}

interface PackagePayload {
  manifestText: string;
  manifest: MaterialProviderManifest;
  entryBytes: Uint8Array;
  files: MaterializedFile[];
  minRequiredVersion?: string;
}

function fail(message: string): never {
  throw new MaterialProviderInstallError(message);
}

function sha256Hex(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}

function assertSafeRelativePath(relativePath: string): string {
  return assertSharedSafeRelativePath(relativePath, "provider package path", fail);
}

function normalizeZipEntryName(name: string): string {
  return assertSafeRelativePath(name.replace(/\\/g, "/"));
}

function resolveCommonRoot(files: string[]): string {
  const safeFiles = files.map((file) => normalizeZipEntryName(file));
  const segments = safeFiles.map((file) => file.split("/"));
  const firstSegment = segments[0]?.[0];
  if (!firstSegment || segments.some((parts) => parts[0] !== firstSegment)) {
    return "";
  }
  return `${firstSegment}/`;
}

function trimRootPrefix(entryName: string, rootPrefix: string): string | null {
  if (!entryName.startsWith(rootPrefix)) return null;
  const relativePath = entryName.slice(rootPrefix.length);
  if (!relativePath) return null;
  return assertSafeRelativePath(relativePath);
}

function assertExpectedManifest(
  payload: PackagePayload,
  manifest: MaterialProviderManifest,
  expectation: MaterialProviderInstallExpectation | undefined,
): void {
  if (expectation?.id && manifest.id !== expectation.id) {
    fail(`manifest id ${manifest.id} does not match registry id ${expectation.id}`);
  }
  if (expectation?.version && manifest.version !== expectation.version) {
    fail(`manifest version ${manifest.version} does not match registry version ${expectation.version}`);
  }
  if (expectation?.kind && manifest.kind !== expectation.kind) {
    fail(`manifest kind ${manifest.kind} does not match registry kind ${expectation.kind}`);
  }
  const currentVersion = expectation?.currentVersion ?? getSystemVersion();
  if (payload.minRequiredVersion && !semverGte(currentVersion, payload.minRequiredVersion)) {
    fail(`provider ${manifest.id} requires paper-search-cli >= ${payload.minRequiredVersion}`);
  }
}

function materialMinRequiredVersion(manifestText: string): string | undefined {
  const parsed = JSON.parse(manifestText) as Record<string, unknown>;
  const value = parsed.minCliVersion ?? parsed.minPluginVersion;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+/.test(value)) {
    fail("manifest.minCliVersion must be semver-like (e.g. 1.0.0)");
  }
  return value;
}

function assertSha256(bytes: Uint8Array, expectedSha256: string, label: string): void {
  const actual = sha256Hex(bytes);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    fail(`${label} SHA-256 checksum mismatch`);
  }
}

function assertIntegrity(payload: PackagePayload): void {
  const sha256 = payload.manifest.integrity?.sha256;
  if (sha256) {
    assertSha256(payload.entryBytes, sha256, `${payload.manifest.id} entry integrity`);
  }
}

async function collectPackageFiles(
  packagePath: string,
  currentPath: string,
  relativePrefix = "",
): Promise<MaterializedFile[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files: MaterializedFile[] = [];
  for (const entry of entries) {
    const relativePath = assertSafeRelativePath(path.posix.join(relativePrefix, entry.name));
    const sourcePath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`Material provider package contains unsupported symlink: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectPackageFiles(packagePath, sourcePath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const resolvedSource = path.resolve(sourcePath);
    const relativeToRoot = path.relative(packagePath, resolvedSource);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      fail(`Material provider package file escapes package root: ${relativePath}`);
    }
    files.push({ relativePath, bytes: new Uint8Array(await readFile(sourcePath)) });
  }
  return files;
}

async function payloadFromPackageDir(packagePath: string): Promise<PackagePayload> {
  const loaded = await loadMaterialProviderPackage(packagePath);
  const manifestText = await readFile(loaded.manifestPath, "utf8");
  const files = await collectPackageFiles(loaded.packagePath, loaded.packagePath);
  const entryPath = loaded.manifest.entry.replace(/\\/g, "/");
  const entryFile = files.find((file) => file.relativePath === entryPath);
  if (!entryFile) {
    fail(`Material provider entrypoint not found in package payload: ${loaded.manifest.entry}`);
  }
  return {
    manifestText,
    manifest: loaded.manifest,
    entryBytes: entryFile.bytes,
    files,
    minRequiredVersion: materialMinRequiredVersion(manifestText),
  };
}

async function payloadFromZipBytes(zipBytes: Uint8Array): Promise<PackagePayload> {
  const archive = await JSZip.loadAsync(zipBytes);
  const fileEntries = Object.values(archive.files).filter((entry) => !entry.dir);
  const fileNames = fileEntries.map((entry) => entry.name);
  const hasFlatManifest = archive.file("manifest.json") !== null;
  const rootPrefix = hasFlatManifest ? "" : resolveCommonRoot(fileNames);
  const manifestEntry = archive.file(`${rootPrefix}manifest.json`);
  if (!manifestEntry) {
    fail("Invalid material provider zip: expected manifest.json at root or inside a single top-level directory");
  }

  const manifestText = await manifestEntry.async("string");
  const manifest = parseMaterialProviderManifest(manifestText);
  const manifestEntryPath = assertSafeRelativePath(manifest.entry);
  const entryZipEntry = archive.file(`${rootPrefix}${manifestEntryPath}`);
  if (!entryZipEntry) {
    fail(`Invalid material provider zip: manifest.entry not found: ${manifest.entry}`);
  }

  const files: MaterializedFile[] = [];
  const seenPaths = new Set<string>();
  for (const entry of fileEntries) {
    const relativePath = trimRootPrefix(normalizeZipEntryName(entry.name), rootPrefix);
    if (!relativePath) continue;
    const collisionKey = relativePath.toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) {
      fail(`Duplicate material provider zip entry path: ${relativePath}`);
    }
    seenPaths.add(collisionKey);
    if (collisionKey === PROVIDER_RECEIPT_FILENAME) {
      fail(`Material provider zip contains reserved receipt path: ${relativePath}`);
    }
    files.push({ relativePath, bytes: await entry.async("uint8array") });
  }

  const entryBytes = await entryZipEntry.async("uint8array");
  return {
    manifestText,
    manifest,
    entryBytes,
    files,
    minRequiredVersion: materialMinRequiredVersion(manifestText),
  };
}

async function materializePayload(
  payload: PackagePayload,
  installDir: string,
  receipt?: ProviderInstallReceipt,
  replacementPrecondition?: MaterialProviderZipInstallPlan["replacementPrecondition"],
  replacementOperations?: InstallPathReplacementOperations,
): Promise<InstallMaterialProviderResult> {
  const resolvedInstallDir = path.resolve(installDir);
  await mkdir(resolvedInstallDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(resolvedInstallDir, "._material_install_"));

  try {
    const hasManifest = payload.files.some((file) => file.relativePath === "manifest.json");
    if (!hasManifest) {
      payload.files.unshift({
        relativePath: "manifest.json",
        bytes: new TextEncoder().encode(payload.manifestText),
      });
    }
    for (const file of payload.files) {
      const relativePath = assertSafeRelativePath(file.relativePath);
      const destination = resolveSafePathInsideRoot(
        tempRoot,
        relativePath,
        "Material provider package path",
        fail,
      ).absolutePath;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    if (receipt) await stageProviderReceipt(tempRoot, receipt);

    const targetPath = path.join(resolvedInstallDir, payload.manifest.id);
    if (replacementPrecondition) {
      await assertProviderReplacementPrecondition(targetPath, replacementPrecondition);
    }
    const { replacedExisting } = await replaceInstallPath({
      stagingPath: tempRoot,
      targetPath,
      providerId: payload.manifest.id,
      ...(replacementOperations ? { operations: replacementOperations } : {}),
    });
    return {
      id: payload.manifest.id,
      manifest: payload.manifest,
      installPath: targetPath,
      replacedExisting,
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installMaterialProviderFromPackageDir(
  packagePath: string,
  installDir: string,
  expectation?: MaterialProviderInstallExpectation,
): Promise<InstallMaterialProviderResult> {
  const payload = await payloadFromPackageDir(path.resolve(packagePath));
  assertExpectedManifest(payload, payload.manifest, expectation);
  if (expectation?.registryChecksum) {
    if (expectation.registryChecksum.target !== "entry") {
      fail("Directory package registry checksums must target provider entry bytes");
    }
    assertSha256(payload.entryBytes, expectation.registryChecksum.sha256, `${payload.manifest.id} registry entry`);
  }
  assertIntegrity(payload);
  if (!expectation) return materializePayload(payload, installDir);
  const resolvedInstallDir = path.resolve(installDir);
  const targetPath = path.join(resolvedInstallDir, payload.manifest.id);
  const replacementPrecondition = await inspectProviderReplacementPrecondition(targetPath);
  const now = new Date().toISOString();
  const receipt: ProviderInstallReceipt = {
    schemaVersion: 1,
    runtimeKind: "material",
    providerKind: payload.manifest.kind,
    id: payload.manifest.id,
    version: payload.manifest.version,
    installType: "legacy-directory",
    bound: false,
    manifestSha256: sha256Bytes(payload.manifestText),
    entryPath: payload.manifest.entry.replace(/\\/g, "/"),
    entrySha256: sha256Hex(payload.entryBytes),
    installedAt: replacementPrecondition.state === "present"
      ? (await readPreviousInstalledAt(path.join(targetPath, PROVIDER_RECEIPT_FILENAME))) ?? now
      : now,
    updatedAt: now,
  };
  return materializePayload(payload, installDir, receipt, replacementPrecondition);
}

export async function installMaterialProviderFromZipFile(
  zipPath: string,
  installDir: string,
  expectation?: MaterialProviderInstallExpectation,
): Promise<InstallMaterialProviderResult> {
  if (!expectation) {
    return applyMaterialProviderZipInstallPlan(
      await planMaterialProviderZipInstall(zipPath, installDir),
    );
  }
  const archiveBytes = new Uint8Array(await readFile(path.resolve(zipPath)));
  return installMaterialProviderFromZipBytes(archiveBytes, installDir, expectation);
}

interface ValidatedMaterialProviderZip {
  payload: PackagePayload;
  archiveSha256: string;
  manifestSha256: string;
  entrySha256: string;
}

async function validateMaterialProviderZipBytes(
  archiveBytes: Uint8Array,
  expectation?: MaterialProviderInstallExpectation,
): Promise<ValidatedMaterialProviderZip> {
  const archiveSha256 = sha256Hex(archiveBytes);
  if (expectation?.registryChecksum) {
    if (expectation.registryChecksum.target !== "archive") {
      fail("Zip registry checksums must target archive bytes");
    }
    assertSha256(archiveBytes, expectation.registryChecksum.sha256, "registry archive");
  }
  const payload = await payloadFromZipBytes(archiveBytes);
  assertExpectedManifest(payload, payload.manifest, expectation);
  assertIntegrity(payload);
  return {
    payload,
    archiveSha256,
    manifestSha256: sha256Bytes(payload.manifestText),
    entrySha256: sha256Hex(payload.entryBytes),
  };
}

function toInspectedMaterialProviderZip(
  validated: ValidatedMaterialProviderZip,
): InspectedMaterialProviderZip {
  return {
    id: validated.payload.manifest.id,
    version: validated.payload.manifest.version,
    providerKind: validated.payload.manifest.kind,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entryPath: validated.payload.manifest.entry.replace(/\\/g, "/"),
    entrySha256: validated.entrySha256,
    manifest: validated.payload.manifest,
  };
}

export async function inspectMaterialProviderZipFile(
  zipPath: string,
  expectation?: MaterialProviderInstallExpectation,
): Promise<InspectedMaterialProviderZip> {
  const archiveBytes = new Uint8Array(await readFile(path.resolve(zipPath)));
  return toInspectedMaterialProviderZip(
    await validateMaterialProviderZipBytes(archiveBytes, expectation),
  );
}

export async function planMaterialProviderZipInstall(
  zipPath: string,
  installDir: string,
  options: { currentVersion?: string } = {},
): Promise<MaterialProviderZipInstallPlan> {
  const currentVersion = options.currentVersion ?? getSystemVersion();
  const archivePath = path.resolve(zipPath);
  const resolvedInstallDir = path.resolve(installDir);
  const archiveBytes = new Uint8Array(await readFile(archivePath));
  const validated = await validateMaterialProviderZipBytes(archiveBytes, { currentVersion });
  const targetPath = path.join(resolvedInstallDir, validated.payload.manifest.id);
  return {
    schemaVersion: 1,
    installType: "manual-zip",
    bound: false,
    runtimeKind: "material",
    providerKind: validated.payload.manifest.kind,
    id: validated.payload.manifest.id,
    version: validated.payload.manifest.version,
    archivePath,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entryPath: validated.payload.manifest.entry.replace(/\\/g, "/"),
    entrySha256: validated.entrySha256,
    installDir: resolvedInstallDir,
    targetPath,
    receiptPath: path.join(targetPath, PROVIDER_RECEIPT_FILENAME),
    replacementPrecondition: await inspectProviderReplacementPrecondition(targetPath),
    currentVersion,
  };
}

function assertValidatedMaterialZipMatchesPlan(
  validated: ValidatedMaterialProviderZip,
  plan: MaterialProviderZipInstallPlan,
): void {
  const actual = {
    id: validated.payload.manifest.id,
    version: validated.payload.manifest.version,
    providerKind: validated.payload.manifest.kind,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entryPath: validated.payload.manifest.entry.replace(/\\/g, "/"),
    entrySha256: validated.entrySha256,
  };
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    if (actual[key] !== plan[key]) {
      fail(`Material provider ZIP changed after planning: ${key}`);
    }
  }
}

export async function applyMaterialProviderZipInstallPlan(
  plan: MaterialProviderZipInstallPlan,
  options: { replacementOperations?: InstallPathReplacementOperations } = {},
): Promise<AppliedMaterialProviderZipInstall> {
  const archiveBytes = new Uint8Array(await readFile(plan.archivePath));
  const validated = await validateMaterialProviderZipBytes(archiveBytes, {
    id: plan.id,
    version: plan.version,
    kind: plan.providerKind,
    currentVersion: plan.currentVersion,
    registryChecksum: { sha256: plan.archiveSha256, target: "archive" },
  });
  assertValidatedMaterialZipMatchesPlan(validated, plan);
  await assertProviderReplacementPrecondition(plan.targetPath, plan.replacementPrecondition);
  const receipt = await createManualZipReceipt(plan);
  const result = await materializePayload(
    validated.payload,
    plan.installDir,
    receipt,
    plan.replacementPrecondition,
    options.replacementOperations,
  );
  return { ...result, plan, receipt };
}

function assertReceiptMatchesMaterialZip(
  receipt: ProviderInstallReceipt,
  inspected: InspectedMaterialProviderZip,
): void {
  const expected = {
    runtimeKind: "material",
    providerKind: inspected.providerKind,
    id: inspected.id,
    version: inspected.version,
    archiveSha256: inspected.archiveSha256,
    manifestSha256: inspected.manifestSha256,
    entryPath: inspected.entryPath,
    entrySha256: inspected.entrySha256,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof ProviderInstallReceipt] !== value) {
      fail(`Material provider receipt does not match validated ZIP: ${key}`);
    }
  }
}

export async function applyMaterialProviderZipInstallWithReceipt(options: {
  zipPath: string;
  installDir: string;
  expectation: MaterialProviderInstallExpectation;
  receipt: ProviderInstallReceipt;
  replacementPrecondition: MaterialProviderZipInstallPlan["replacementPrecondition"];
  replacementOperations?: InstallPathReplacementOperations;
}): Promise<InstallMaterialProviderResult> {
  const archiveBytes = new Uint8Array(await readFile(path.resolve(options.zipPath)));
  const validated = await validateMaterialProviderZipBytes(archiveBytes, options.expectation);
  const inspected = toInspectedMaterialProviderZip(validated);
  assertReceiptMatchesMaterialZip(options.receipt, inspected);
  const targetPath = path.join(path.resolve(options.installDir), inspected.id);
  await assertProviderReplacementPrecondition(targetPath, options.replacementPrecondition);
  return materializePayload(
    validated.payload,
    options.installDir,
    options.receipt,
    options.replacementPrecondition,
    options.replacementOperations,
  );
}

export async function installMaterialProviderFromZipBytes(
  archiveBytes: Uint8Array,
  installDir: string,
  expectation?: MaterialProviderInstallExpectation,
): Promise<InstallMaterialProviderResult> {
  const validated = await validateMaterialProviderZipBytes(archiveBytes, expectation);
  return materializePayload(validated.payload, installDir);
}
