import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { resolveSubscriptionPaths } from "../subscriptions/paths.js";
import type { ProviderRuntimeKind } from "./install/manualZip.js";

export interface ProviderLifecyclePaths {
  providersRoot: string;
  searchInstallDir: string;
  materialInstallDir: string;
  archiveCacheDir: string;
  migrationStateDir: string;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function assertProviderId(id: string): void {
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error(`Invalid provider id: ${id}`);
}

/** Resolve the v1 write directory beneath a configured compatibility root. */
export function configuredProviderInstallDir(
  configuredInstallDir: string,
  runtimeKind: ProviderRuntimeKind,
): string {
  return path.join(path.resolve(configuredInstallDir), runtimeKind);
}

/** Resolve a v1 provider target beneath a configured compatibility root. */
export function configuredProviderTargetPath(
  configuredInstallDir: string,
  runtimeKind: ProviderRuntimeKind,
  id: string,
): string {
  assertProviderId(id);
  return path.join(configuredProviderInstallDir(configuredInstallDir, runtimeKind), id);
}

/** Resolve the legacy flat read/migration target beneath a compatibility root. */
export function configuredLegacyProviderTargetPath(
  configuredInstallDir: string,
  id: string,
): string {
  assertProviderId(id);
  return path.join(path.resolve(configuredInstallDir), id);
}

export function resolveProviderLifecyclePaths(
  env: NodeJS.ProcessEnv = process.env,
): ProviderLifecyclePaths {
  const subscriptionPaths = resolveSubscriptionPaths(env);
  return {
    providersRoot: subscriptionPaths.providersDir,
    searchInstallDir: path.join(subscriptionPaths.providersDir, "search"),
    materialInstallDir: path.join(subscriptionPaths.providersDir, "material"),
    archiveCacheDir: path.join(subscriptionPaths.dataRoot, "cache", "archives"),
    migrationStateDir: path.join(subscriptionPaths.dataRoot, "state", "migrations"),
  };
}

export function providerInstallDir(
  runtimeKind: ProviderRuntimeKind,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredProviderInstallDir(resolveProviderLifecyclePaths(env).providersRoot, runtimeKind);
}

export function providerTargetPath(
  runtimeKind: ProviderRuntimeKind,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredProviderTargetPath(resolveProviderLifecyclePaths(env).providersRoot, runtimeKind, id);
}

export function legacyProviderTargetPath(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return configuredLegacyProviderTargetPath(resolveProviderLifecyclePaths(env).providersRoot, id);
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await lstat(targetPath)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Resolve a configured compatibility root against the v1 kind-separated
 * layout. The kind path wins; the legacy flat path remains a read fallback.
 */
export async function resolveProviderPackageDirectory(
  configuredInstallDir: string,
  runtimeKind: ProviderRuntimeKind,
  id: string,
): Promise<string> {
  const kindTarget = configuredProviderTargetPath(configuredInstallDir, runtimeKind, id);
  if (await isDirectory(kindTarget)) return kindTarget;
  // These names are reserved by the v1 directory layout and cannot be flat
  // provider fallbacks without confusing a kind root for a package.
  if (id === "search" || id === "material") return kindTarget;
  return configuredLegacyProviderTargetPath(configuredInstallDir, id);
}

export async function listProviderPackageDirectories(
  configuredInstallDir: string,
  runtimeKind: ProviderRuntimeKind,
): Promise<string[]> {
  const root = path.resolve(configuredInstallDir);
  const rootEntries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const paths: string[] = [];
  const kindRoot = configuredProviderInstallDir(root, runtimeKind);
  const kindNames = new Set<string>();
  if (rootEntries.some((entry) => entry.name === runtimeKind && entry.isDirectory())) {
    const kindEntries = await readdir(kindRoot, { withFileTypes: true });
    for (const entry of kindEntries
      .filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      kindNames.add(entry.name);
      paths.push(path.join(kindRoot, entry.name));
    }
  }
  paths.push(...rootEntries
    .filter((entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "search" &&
      entry.name !== "material" &&
      !kindNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(root, entry.name)));
  return paths;
}
