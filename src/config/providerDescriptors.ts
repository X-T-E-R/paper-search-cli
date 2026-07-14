import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseMaterialProviderManifest } from "../material/manifest.js";
import { parseProviderManifest } from "../providers/manifest/validate.js";
import { resolveInstallPaths } from "../runtime/installLayout.js";
import type { ConfigKeyMetadata } from "./userConfig.js";

type DescriptorKind = ConfigKeyMetadata[string];

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

async function directories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(root, entry.name));
}

function addDescriptor(
  metadata: Record<string, DescriptorKind>,
  conflicts: Set<string>,
  key: string,
  kind: DescriptorKind,
): void {
  if (conflicts.has(key)) return;
  const previous = metadata[key];
  if (previous && previous !== kind) {
    delete metadata[key];
    conflicts.add(key);
    return;
  }
  metadata[key] = kind;
}

async function inspectManifest(
  providerPath: string,
  expectedKind: "search" | "material" | "legacy",
): Promise<{ id: string; descriptors: Array<[string, DescriptorKind]> } | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(providerPath, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  const matches: Array<{ id: string; descriptors: Array<[string, DescriptorKind]> }> = [];
  if (expectedKind !== "material") {
    try {
      const manifest = parseProviderManifest(raw);
      matches.push({
        id: manifest.id,
        descriptors: Object.entries(manifest.configSchema ?? {}).map(([field, descriptor]) => [
          field,
          descriptor.secret ? "secret" : "non-secret",
        ]),
      });
    } catch {
      // Invalid search manifests cannot define configuration authority.
    }
  }
  if (expectedKind !== "search") {
    try {
      const manifest = parseMaterialProviderManifest(raw);
      matches.push({
        id: manifest.id,
        descriptors: Object.entries(manifest.configSchema ?? {}).map(([field, descriptor]) => [
          field,
          descriptor.type === "secret" ? "secret" : "non-secret",
        ]),
      });
    } catch {
      // Invalid material manifests cannot define configuration authority.
    }
  }
  // Flat compatibility directories must classify unambiguously, matching the
  // provider migration contract rather than guessing a runtime kind.
  return matches.length === 1 ? matches[0]! : null;
}

async function scanRoot(
  root: string,
  metadata: Record<string, DescriptorKind>,
  conflicts: Set<string>,
): Promise<void> {
  const roots: Array<{ path: string; kind: "search" | "material" | "legacy" }> = [
    { path: path.join(root, "search"), kind: "search" },
    { path: path.join(root, "material"), kind: "material" },
  ];
  for (const providerPath of await directories(root)) {
    const name = path.basename(providerPath);
    if (name !== "search" && name !== "material") roots.push({ path: providerPath, kind: "legacy" });
  }
  for (const nested of [roots[0]!, roots[1]!]) {
    for (const providerPath of await directories(nested.path)) {
      const inspected = await inspectManifest(providerPath, nested.kind);
      if (!inspected) continue;
      for (const [field, kind] of inspected.descriptors) {
        addDescriptor(metadata, conflicts, `platform.${inspected.id}.${field}`, kind);
      }
    }
  }
  for (const flat of roots.slice(2)) {
    const inspected = await inspectManifest(flat.path, "legacy");
    if (!inspected) continue;
    for (const [field, kind] of inspected.descriptors) {
      addDescriptor(metadata, conflicts, `platform.${inspected.id}.${field}`, kind);
    }
  }
}

/**
 * Read validated installed manifests without loading provider executable code.
 * Kind-separated lifecycle locations are authoritative. A configured custom
 * root is scanned as a compatibility input, while the machine data-root remains
 * visible so a compatibility override cannot hide lifecycle-owned descriptors.
 */
export async function loadInstalledProviderConfigMetadata(
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigKeyMetadata> {
  const configuredRoot = path.resolve(installDir);
  const lifecycleRoot = path.join(resolveInstallPaths(env).dataRoot, "providers");
  const roots = samePath(configuredRoot, lifecycleRoot)
    ? [lifecycleRoot]
    : [lifecycleRoot, configuredRoot];
  const metadata: Record<string, DescriptorKind> = {};
  const conflicts = new Set<string>();
  for (const root of roots) await scanRoot(root, metadata, conflicts);
  return metadata;
}
