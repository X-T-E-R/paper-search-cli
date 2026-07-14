import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { getSystemVersion, semverGte } from "../../runtime/version.js";
import {
  assertSafeRelativePath,
  resolveSafePathInsideRoot,
} from "../../runtime/safeRelativePath.js";
import { parseProviderManifest } from "../manifest/validate.js";
import type { ProviderManifest } from "../sdk/types.js";
import { removeInstallPath } from "./cleanup.js";
import {
  assertProviderReplacementPrecondition,
  createManualZipReceipt,
  inspectProviderReplacementPrecondition,
  PROVIDER_RECEIPT_FILENAME,
  sha256Bytes,
  stageProviderReceipt,
  type ManualZipInstallPlan,
  type ProviderInstallReceipt,
} from "./manualZip.js";
import {
  replaceInstallPath,
  type InstallPathReplacementOperations,
} from "./replace.js";

interface ZipPayload {
  manifestText: string;
  providerBytes: Uint8Array;
  extraFiles: Array<{ relativePath: string; bytes: Uint8Array }>;
}

interface ValidatedProviderZip {
  archiveBytes: Uint8Array;
  archiveSha256: string;
  manifest: ProviderManifest;
  manifestSha256: string;
  entrySha256: string;
  payload: ZipPayload;
}

export interface ProviderInstallExpectation {
  id?: string;
  version?: string;
  sha256?: string;
  currentVersion?: string;
}

export interface InstallZipResult {
  id: string;
  manifest: ProviderManifest;
  installPath: string;
  replacedExisting: boolean;
}

export interface ProviderZipInstallPlan extends ManualZipInstallPlan {
  runtimeKind: "search";
  providerKind: ProviderManifest["sourceType"];
}

export interface AppliedProviderZipInstall extends InstallZipResult {
  plan: ProviderZipInstallPlan;
  receipt: ProviderInstallReceipt;
}

export interface InspectedProviderZip {
  id: string;
  version: string;
  providerKind: ProviderManifest["sourceType"];
  archiveSha256: string;
  manifestSha256: string;
  entryPath: "provider.js";
  entrySha256: string;
  manifest: ProviderManifest;
}

function sha256Hex(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}

function normalizeZipEntryName(name: string): string {
  return assertSafeRelativePath(name, "provider ZIP entry path");
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

async function extractZipPayload(archiveBytes: Uint8Array): Promise<ZipPayload> {
  const archive = await JSZip.loadAsync(archiveBytes);
  const files = Object.values(archive.files).filter((entry) => !entry.dir);
  const names = files.map((entry) =>
    normalizeZipEntryName(
      (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name,
    ),
  );

  const hasFlatManifest = archive.file("manifest.json");
  const hasFlatProvider = archive.file("provider.js");
  const rootPrefix = hasFlatManifest && hasFlatProvider ? "" : resolveCommonRoot(names);

  const manifestEntry = archive.file(`${rootPrefix}manifest.json`);
  const providerEntry = archive.file(`${rootPrefix}provider.js`);
  if (!manifestEntry || !providerEntry) {
    throw new Error(
      "Invalid zip: expected manifest.json and provider.js at root or inside a single top-level directory",
    );
  }

  const manifestText = await manifestEntry.async("string");
  const providerBytes = await providerEntry.async("uint8array");
  const extraFiles: Array<{ relativePath: string; bytes: Uint8Array }> = [];
  const seenPaths = new Set(["manifest.json", "provider.js"]);

  for (let index = 0; index < files.length; index++) {
    const entry = files[index]!;
    const normalizedEntryName = names[index]!;
    if (!normalizedEntryName.startsWith(rootPrefix)) continue;
    const relativePath = assertSafeRelativePath(
      normalizedEntryName.slice(rootPrefix.length),
      "provider ZIP entry path",
    );
    if (relativePath === "manifest.json" || relativePath === "provider.js") continue;
    if (relativePath.toLocaleLowerCase("en-US") === PROVIDER_RECEIPT_FILENAME) {
      throw new Error(`Provider ZIP contains reserved receipt path: ${relativePath}`);
    }
    const collisionKey = relativePath.toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) {
      throw new Error(`Duplicate provider ZIP entry path: ${relativePath}`);
    }
    seenPaths.add(collisionKey);
    extraFiles.push({
      relativePath,
      bytes: await entry.async("uint8array"),
    });
  }

  return { manifestText, providerBytes, extraFiles };
}

async function loadValidatedProviderZip(
  zipPath: string,
  expectation?: ProviderInstallExpectation,
): Promise<ValidatedProviderZip> {
  const archiveBytes = new Uint8Array(await readFile(path.resolve(zipPath)));
  const archiveSha256 = sha256Hex(archiveBytes);
  if (
    expectation?.sha256 &&
    archiveSha256.toLowerCase() !== expectation.sha256.toLowerCase()
  ) {
    throw new Error("registry archive SHA-256 checksum mismatch");
  }

  const payload = await extractZipPayload(archiveBytes);
  const manifest = parseProviderManifest(payload.manifestText);
  assertExpectedManifest(manifest, expectation);
  const entrySha256 = sha256Hex(payload.providerBytes);
  if (
    manifest.integrity?.sha256 &&
    entrySha256.toLowerCase() !== manifest.integrity.sha256.toLowerCase()
  ) {
    throw new Error(`provider.js integrity check failed for ${manifest.id}`);
  }
  return {
    archiveBytes,
    archiveSha256,
    manifest,
    manifestSha256: sha256Bytes(payload.manifestText),
    entrySha256,
    payload,
  };
}

function toInspectedProviderZip(validated: ValidatedProviderZip): InspectedProviderZip {
  return {
    id: validated.manifest.id,
    version: validated.manifest.version,
    providerKind: validated.manifest.sourceType,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entryPath: "provider.js",
    entrySha256: validated.entrySha256,
    manifest: validated.manifest,
  };
}

export async function inspectProviderZipFile(
  zipPath: string,
  expectation?: ProviderInstallExpectation,
): Promise<InspectedProviderZip> {
  return toInspectedProviderZip(await loadValidatedProviderZip(path.resolve(zipPath), expectation));
}

export async function planProviderZipInstall(
  zipPath: string,
  installDir: string,
  options: { currentVersion?: string } = {},
): Promise<ProviderZipInstallPlan> {
  const currentVersion = options.currentVersion ?? getSystemVersion();
  const archivePath = path.resolve(zipPath);
  const resolvedInstallDir = path.resolve(installDir);
  const validated = await loadValidatedProviderZip(archivePath, { currentVersion });
  const targetPath = path.join(resolvedInstallDir, validated.manifest.id);
  return {
    schemaVersion: 1,
    installType: "manual-zip",
    bound: false,
    runtimeKind: "search",
    providerKind: validated.manifest.sourceType,
    id: validated.manifest.id,
    version: validated.manifest.version,
    archivePath,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entryPath: "provider.js",
    entrySha256: validated.entrySha256,
    installDir: resolvedInstallDir,
    targetPath,
    receiptPath: path.join(targetPath, PROVIDER_RECEIPT_FILENAME),
    replacementPrecondition: await inspectProviderReplacementPrecondition(targetPath),
    currentVersion,
  };
}

function assertValidatedZipMatchesPlan(
  validated: ValidatedProviderZip,
  plan: ProviderZipInstallPlan,
): void {
  const actual = {
    id: validated.manifest.id,
    version: validated.manifest.version,
    providerKind: validated.manifest.sourceType,
    archiveSha256: validated.archiveSha256,
    manifestSha256: validated.manifestSha256,
    entrySha256: validated.entrySha256,
  };
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    if (actual[key] !== plan[key]) {
      throw new Error(`Provider ZIP changed after planning: ${key}`);
    }
  }
}

export async function applyProviderZipInstallPlan(
  plan: ProviderZipInstallPlan,
  options: { replacementOperations?: InstallPathReplacementOperations } = {},
): Promise<AppliedProviderZipInstall> {
  const validated = await loadValidatedProviderZip(plan.archivePath, {
    id: plan.id,
    version: plan.version,
    sha256: plan.archiveSha256,
    currentVersion: plan.currentVersion,
  });
  assertValidatedZipMatchesPlan(validated, plan);
  await assertProviderReplacementPrecondition(plan.targetPath, plan.replacementPrecondition);
  const receipt = await createManualZipReceipt(plan);
  const result = await materializeProviderPayload(
    validated.payload,
    validated.manifest,
    plan.installDir,
    receipt,
    plan.replacementPrecondition,
    options.replacementOperations,
  );
  return { ...result, plan, receipt };
}

function assertReceiptMatchesProviderZip(
  receipt: ProviderInstallReceipt,
  inspected: InspectedProviderZip,
): void {
  const expected = {
    runtimeKind: "search",
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
      throw new Error(`Provider receipt does not match validated ZIP: ${key}`);
    }
  }
}

export async function applyProviderZipInstallWithReceipt(options: {
  zipPath: string;
  installDir: string;
  expectation: ProviderInstallExpectation;
  receipt: ProviderInstallReceipt;
  replacementPrecondition: ProviderZipInstallPlan["replacementPrecondition"];
  replacementOperations?: InstallPathReplacementOperations;
}): Promise<InstallZipResult> {
  const validated = await loadValidatedProviderZip(path.resolve(options.zipPath), options.expectation);
  const inspected = toInspectedProviderZip(validated);
  assertReceiptMatchesProviderZip(options.receipt, inspected);
  const targetPath = path.join(path.resolve(options.installDir), inspected.id);
  await assertProviderReplacementPrecondition(targetPath, options.replacementPrecondition);
  return materializeProviderPayload(
    validated.payload,
    validated.manifest,
    options.installDir,
    options.receipt,
    options.replacementPrecondition,
    options.replacementOperations,
  );
}

async function materializeProviderPayload(
  payload: ZipPayload,
  manifest: ProviderManifest,
  installDir: string,
  receipt?: ProviderInstallReceipt,
  replacementPrecondition?: ProviderZipInstallPlan["replacementPrecondition"],
  replacementOperations?: InstallPathReplacementOperations,
): Promise<InstallZipResult> {
  const resolvedInstallDir = path.resolve(installDir);
  await mkdir(resolvedInstallDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(resolvedInstallDir, "._install_"));

  try {
    await writeFile(path.join(tempRoot, "manifest.json"), payload.manifestText, "utf8");
    await writeFile(path.join(tempRoot, "provider.js"), payload.providerBytes);
    for (const file of payload.extraFiles) {
      const destination = resolveSafePathInsideRoot(
        tempRoot,
        file.relativePath,
        "provider ZIP entry path",
      ).absolutePath;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    if (receipt) await stageProviderReceipt(tempRoot, receipt);

    const targetPath = path.join(resolvedInstallDir, manifest.id);
    if (replacementPrecondition) {
      await assertProviderReplacementPrecondition(targetPath, replacementPrecondition);
    }
    const { replacedExisting } = await replaceInstallPath({
      stagingPath: tempRoot,
      targetPath,
      providerId: manifest.id,
      ...(replacementOperations ? { operations: replacementOperations } : {}),
    });
    return {
      id: manifest.id,
      manifest,
      installPath: targetPath,
      replacedExisting,
    };
  } catch (error) {
    await removeInstallPath(tempRoot).catch(() => undefined);
    throw error;
  }
}

function assertExpectedManifest(
  manifest: ProviderManifest,
  expectation: ProviderInstallExpectation | undefined,
): void {
  if (expectation?.id && manifest.id !== expectation.id) {
    throw new Error(
      `manifest id ${manifest.id} does not match registry id ${expectation.id}`,
    );
  }
  if (expectation?.version && manifest.version !== expectation.version) {
    throw new Error(
      `manifest version ${manifest.version} does not match registry version ${expectation.version}`,
    );
  }
  const currentVersion = expectation?.currentVersion ?? getSystemVersion();
  if (
    manifest.minPluginVersion &&
    !semverGte(currentVersion, manifest.minPluginVersion)
  ) {
    throw new Error(
      `provider ${manifest.id} requires paper-search-cli >= ${manifest.minPluginVersion}`,
    );
  }
}

export async function installProviderFromZipFile(
  zipPath: string,
  installDir: string,
  expectation?: ProviderInstallExpectation,
): Promise<AppliedProviderZipInstall> {
  if (!expectation) {
    return applyProviderZipInstallPlan(await planProviderZipInstall(zipPath, installDir));
  }
  const plan = await planProviderZipInstall(zipPath, installDir, {
    currentVersion: expectation.currentVersion,
  });
  if (expectation.id && plan.id !== expectation.id) {
    throw new Error(`manifest id ${plan.id} does not match registry id ${expectation.id}`);
  }
  if (expectation.version && plan.version !== expectation.version) {
    throw new Error(`manifest version ${plan.version} does not match registry version ${expectation.version}`);
  }
  if (expectation.sha256 && plan.archiveSha256.toLowerCase() !== expectation.sha256.toLowerCase()) {
    throw new Error("registry archive SHA-256 checksum mismatch");
  }
  return applyProviderZipInstallPlan(plan);
}
