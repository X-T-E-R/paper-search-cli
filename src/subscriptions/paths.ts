import { createHash } from "node:crypto";
import path from "node:path";
import { resolveConfigBundlePaths } from "../config/paths.js";
import { resolveInstallPaths } from "../runtime/installLayout.js";

export function subscriptionIdDigest(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

export function resolveSubscriptionPaths(env: NodeJS.ProcessEnv = process.env) {
  const dataRoot = resolveInstallPaths(env).dataRoot;
  return {
    dataRoot,
    subscriptionsFile: resolveConfigBundlePaths(env).subscriptions,
    identitiesDir: path.join(dataRoot, "state", "subscriptions"),
    operationsDir: path.join(dataRoot, "state", "registry-ops"),
    locksDir: path.join(dataRoot, "state", "locks"),
    cacheDir: path.join(dataRoot, "cache", "registries"),
    providersDir: path.join(dataRoot, "providers"),
  };
}

export function identityPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSubscriptionPaths(env).identitiesDir, `${subscriptionIdDigest(id)}.json`);
}

export function tombstonesPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSubscriptionPaths(env).identitiesDir, `${subscriptionIdDigest(id)}.tombstones.json`);
}
