import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseProviderManifest } from "../manifest/validate.js";
import type { ProviderManifest } from "../sdk/types.js";

export interface LoadedProviderPackage {
  packagePath: string;
  manifestPath: string;
  providerScriptPath: string;
  manifest: ProviderManifest;
  bundleCode: string;
}

export async function loadProviderPackage(packagePath: string): Promise<LoadedProviderPackage> {
  const resolvedPackagePath = path.resolve(packagePath);
  const manifestPath = path.join(resolvedPackagePath, "manifest.json");
  const providerScriptPath = path.join(resolvedPackagePath, "provider.js");
  const [manifestRaw, bundleCode] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(providerScriptPath, "utf8"),
  ]);
  const manifest = parseProviderManifest(manifestRaw);

  return {
    packagePath: resolvedPackagePath,
    manifestPath,
    providerScriptPath,
    manifest,
    bundleCode,
  };
}
