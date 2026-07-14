import { access } from "node:fs/promises";
import path from "node:path";

async function packageDirReady(candidate: string): Promise<boolean> {
  try {
    await access(path.join(candidate, "manifest.json"));
    await access(path.join(candidate, "provider.js"));
    return true;
  } catch {
    return false;
  }
}

/** Resolve a built material-providers package directory (offline integration tests). */
export async function resolveDistributableMaterialPackageDir(providerId: string): Promise<string> {
  const candidates = [
    path.resolve("..", "material-providers", "dist", providerId),
    path.resolve("..", "material-providers", "src", "providers", "packages", providerId),
  ];
  for (const candidate of candidates) {
    if (await packageDirReady(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Distributable material package "${providerId}" not found. Build systems/material-providers (npm run build).`,
  );
}
