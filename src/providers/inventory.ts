import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseMaterialProviderManifest } from "../material/manifest.js";
import { parseProviderManifest } from "./manifest/validate.js";
import {
  assertProviderReplacementPrecondition,
  inspectProviderReplacementPrecondition,
  parseProviderInstallReceipt,
  PROVIDER_RECEIPT_FILENAME,
  sha256Bytes,
  type ProviderInstallReceipt,
  type ProviderReplacementPrecondition,
  type ProviderRuntimeKind,
} from "./install/manualZip.js";
import {
  legacyProviderTargetPath,
  providerTargetPath,
  resolveProviderLifecyclePaths,
} from "./paths.js";

export interface ProviderDirectoryInspection {
  runtimeKind: ProviderRuntimeKind;
  providerKind: string;
  id: string;
  version: string;
  path: string;
  manifestSha256: string;
  entryPath: string;
  entrySha256: string;
  receipt: ProviderInstallReceipt | null;
  receiptError?: string;
  issues: string[];
  healthy: boolean;
  bound: boolean;
}

export interface ProviderNamespacePrecondition {
  search: ProviderReplacementPrecondition;
  material: ProviderReplacementPrecondition;
  legacy: ProviderReplacementPrecondition;
}

async function readReceipt(providerPath: string): Promise<{
  receipt: ProviderInstallReceipt | null;
  error?: string;
}> {
  const receiptPath = path.join(providerPath, PROVIDER_RECEIPT_FILENAME);
  try {
    return { receipt: parseProviderInstallReceipt(await readFile(receiptPath, "utf8"), receiptPath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { receipt: null };
    return { receipt: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectProviderDirectory(
  runtimeKind: ProviderRuntimeKind,
  providerPath: string,
): Promise<ProviderDirectoryInspection> {
  const resolvedPath = path.resolve(providerPath);
  const manifestText = await readFile(path.join(resolvedPath, "manifest.json"), "utf8");
  const parsed = runtimeKind === "search"
    ? (() => {
        const manifest = parseProviderManifest(manifestText);
        return {
          id: manifest.id,
          version: manifest.version,
          providerKind: manifest.sourceType,
          entryPath: "provider.js",
        };
      })()
    : (() => {
        const manifest = parseMaterialProviderManifest(manifestText);
        return {
          id: manifest.id,
          version: manifest.version,
          providerKind: manifest.kind,
          entryPath: manifest.entry.replace(/\\/g, "/"),
        };
      })();
  const providerKind = parsed.providerKind;
  const entryPath = parsed.entryPath;
  const entryBytes = new Uint8Array(await readFile(path.join(resolvedPath, ...entryPath.split("/"))));
  const manifestSha256 = sha256Bytes(manifestText);
  const entrySha256 = sha256Bytes(entryBytes);
  const read = await readReceipt(resolvedPath);
  const issues: string[] = [];
  if (!read.receipt) {
    issues.push(read.error ?? "provider receipt is missing");
  } else {
    const receipt = read.receipt;
    if (receipt.runtimeKind !== runtimeKind) issues.push("receipt runtimeKind differs from directory");
    if (receipt.providerKind !== providerKind) issues.push("receipt providerKind differs from manifest");
    if (receipt.id !== parsed.id) issues.push("receipt id differs from manifest");
    if (receipt.version !== parsed.version) issues.push("receipt version differs from manifest");
    if (receipt.manifestSha256 !== manifestSha256) issues.push("manifest digest differs from receipt");
    if (receipt.entryPath !== entryPath) issues.push("entry path differs from receipt");
    if (receipt.entrySha256 !== entrySha256) issues.push("entry digest differs from receipt");
  }
  return {
    runtimeKind,
    providerKind,
    id: parsed.id,
    version: parsed.version,
    path: resolvedPath,
    manifestSha256,
    entryPath,
    entrySha256,
    receipt: read.receipt,
    ...(read.error ? { receiptError: read.error } : {}),
    issues,
    healthy: issues.length === 0,
    bound: Boolean(read.receipt?.bound && issues.length === 0),
  };
}

export async function listProviderInstallations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderDirectoryInspection[]> {
  const paths = resolveProviderLifecyclePaths(env);
  const result: ProviderDirectoryInspection[] = [];
  for (const [runtimeKind, installDir] of [
    ["search", paths.searchInstallDir],
    ["material", paths.materialInstallDir],
  ] as const) {
    const entries = await readdir(installDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const inspected = await inspectProviderDirectory(runtimeKind, path.join(installDir, entry.name));
        if (inspected.id !== entry.name) {
          inspected.issues.push(`directory name ${entry.name} differs from manifest id ${inspected.id}`);
          inspected.healthy = false;
          inspected.bound = false;
        }
        result.push(inspected);
      } catch (error) {
        result.push({
          runtimeKind,
          providerKind: "unknown",
          id: entry.name,
          version: "unknown",
          path: path.join(installDir, entry.name),
          manifestSha256: "",
          entryPath: "",
          entrySha256: "",
          receipt: null,
          issues: [error instanceof Error ? error.message : String(error)],
          healthy: false,
          bound: false,
        });
      }
    }
  }
  return result.sort((left, right) =>
    left.id.localeCompare(right.id) || left.runtimeKind.localeCompare(right.runtimeKind));
}

export async function captureProviderNamespacePrecondition(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderNamespacePrecondition> {
  const [search, material, legacy] = await Promise.all([
    inspectProviderReplacementPrecondition(providerTargetPath("search", id, env)),
    inspectProviderReplacementPrecondition(providerTargetPath("material", id, env)),
    id === "search" || id === "material"
      ? Promise.resolve({ state: "absent" } as const)
      : inspectProviderReplacementPrecondition(legacyProviderTargetPath(id, env)),
  ]);
  return { search, material, legacy };
}

export async function assertProviderNamespacePrecondition(
  id: string,
  expected: ProviderNamespacePrecondition,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const assertions = [
    assertProviderReplacementPrecondition(providerTargetPath("search", id, env), expected.search),
    assertProviderReplacementPrecondition(providerTargetPath("material", id, env), expected.material),
  ];
  if (id !== "search" && id !== "material") {
    assertions.push(assertProviderReplacementPrecondition(legacyProviderTargetPath(id, env), expected.legacy));
  }
  await Promise.all(assertions);
}

export function namespacePresentKinds(precondition: ProviderNamespacePrecondition): string[] {
  return (Object.entries(precondition) as Array<[keyof ProviderNamespacePrecondition, ProviderReplacementPrecondition]>)
    .filter(([, state]) => state.state === "present")
    .map(([kind]) => kind);
}

export async function reconcileProviderInstallations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  installations: ProviderDirectoryInspection[];
  duplicateIds: string[];
  unhealthyIds: string[];
  unboundIds: string[];
}> {
  const installations = await listProviderInstallations(env);
  const counts = new Map<string, number>();
  for (const installation of installations) {
    counts.set(installation.id, (counts.get(installation.id) ?? 0) + 1);
  }
  return {
    installations,
    duplicateIds: [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    unhealthyIds: installations.filter((entry) => !entry.healthy).map((entry) => entry.id).sort(),
    unboundIds: installations.filter((entry) => entry.healthy && !entry.bound).map((entry) => entry.id).sort(),
  };
}
