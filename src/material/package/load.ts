import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseMaterialProviderManifest } from "../manifest.js";
import type { MaterialProviderManifest } from "../types.js";

export class MaterialProviderPackageLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialProviderPackageLoadError";
  }
}

export interface LoadedMaterialProviderPackage {
  packagePath: string;
  manifestPath: string;
  entrypointPath: string;
  manifest: MaterialProviderManifest;
  bundleCode: string;
}

export async function loadMaterialProviderPackage(
  packagePath: string,
): Promise<LoadedMaterialProviderPackage> {
  const resolvedPackagePath = path.resolve(packagePath);
  const manifestPath = path.join(resolvedPackagePath, "manifest.json");
  const manifestRaw = await readPackageText(manifestPath, "material provider manifest");
  const manifest = parseMaterialProviderManifest(manifestRaw);
  const entrypointPath = path.resolve(resolvedPackagePath, manifest.entry);

  assertPathInsidePackage(resolvedPackagePath, entrypointPath, "manifest.entry escapes package root");

  const entrypointStat = await statEntrypoint(entrypointPath, manifest.entry);
  if (!entrypointStat.isFile()) {
    throw new MaterialProviderPackageLoadError(
      `Material provider entrypoint must be a file: ${manifest.entry}`,
    );
  }

  await assertRealPathInsidePackage(resolvedPackagePath, entrypointPath, manifest.entry);
  const bundleCode = await readPackageText(entrypointPath, "material provider entrypoint");

  return {
    packagePath: resolvedPackagePath,
    manifestPath,
    entrypointPath,
    manifest,
    bundleCode,
  };
}

async function readPackageText(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new MaterialProviderPackageLoadError(
      `Unable to read ${label} at ${filePath}: ${formatFileError(error)}`,
    );
  }
}

async function statEntrypoint(entrypointPath: string, manifestEntry: string) {
  try {
    return await stat(entrypointPath);
  } catch (error) {
    throw new MaterialProviderPackageLoadError(
      `Material provider entrypoint not found: ${manifestEntry} (${formatFileError(error)})`,
    );
  }
}

async function assertRealPathInsidePackage(
  packagePath: string,
  entrypointPath: string,
  manifestEntry: string,
): Promise<void> {
  const [packageRealPath, entrypointRealPath] = await Promise.all([
    realpath(packagePath),
    realpath(entrypointPath),
  ]);
  assertPathInsidePackage(
    packageRealPath,
    entrypointRealPath,
    `Material provider entrypoint escapes package root: ${manifestEntry}`,
  );
}

function assertPathInsidePackage(packagePath: string, candidatePath: string, message: string): void {
  const relative = path.relative(packagePath, candidatePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new MaterialProviderPackageLoadError(message);
}

function formatFileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
