import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalRegistrySource, RegistryRuntimeKind } from "./types.js";

const SECRET_QUERY_NAME = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key)/i;

export const OFFICIAL_SEARCH_REGISTRY_URL =
  "https://github.com/X-T-E-R/resource-search-providers/releases/download/providers-registry-latest/registry.json";
export const OFFICIAL_MATERIAL_REGISTRY_URL =
  "https://github.com/X-T-E-R/material-providers/releases/download/material-registry-latest/registry.json";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function configuredUrlDigest(url: string): string {
  return sha256(`paper-search-configured-url-v1\0${url}`);
}

export function assertSubscriptionId(id: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error(`Subscription id must match /^[a-z][a-z0-9-]{0,62}$/: ${id}`);
  }
  return id;
}

function fingerprint(kind: RegistryRuntimeKind, sourceType: "https" | "local", source: string): string {
  return sha256(`paper-search-source-v1\0${kind}\0${sourceType}\0${source}`);
}

export async function canonicalizeRegistrySource(
  raw: string,
  runtimeKind: RegistryRuntimeKind,
): Promise<CanonicalRegistrySource> {
  const input = raw.trim();
  if (!input) throw new Error("Registry source must not be empty");
  if (/^https?:/i.test(input)) {
    const url = new URL(input);
    if (url.protocol !== "https:") throw new Error("Registry URL must use HTTPS");
    if (url.username || url.password) throw new Error("Registry URL must not contain userinfo");
    if (url.hash) throw new Error("Registry URL must not contain a fragment");
    if (!url.pathname.toLowerCase().endsWith(".json")) {
      throw new Error("Registry URL must be an exact JSON URL");
    }
    for (const [name] of url.searchParams) {
      if (SECRET_QUERY_NAME.test(name)) {
        throw new Error(`Registry URL must not contain credential-like query parameter: ${name}`);
      }
    }
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    if (url.port === "443") url.port = "";
    const canonicalSource = url.toString();
    return {
      sourceType: "https",
      canonicalSource,
      sourceFingerprint: fingerprint(runtimeKind, "https", canonicalSource),
      configuredUrlDigest: configuredUrlDigest(raw),
    };
  }

  const inputPath = input.startsWith("file:") ? fileURLToPath(input) : path.resolve(input);
  if (!inputPath.toLowerCase().endsWith(".json")) {
    throw new Error("Local registry source must be a JSON file");
  }
  let canonicalSource = await realpath(inputPath);
  canonicalSource = canonicalSource.replace(/\\/g, "/");
  if (process.platform === "win32") canonicalSource = canonicalSource.toLowerCase();
  return {
    sourceType: "local",
    canonicalSource,
    sourceFingerprint: fingerprint(runtimeKind, "local", canonicalSource),
    configuredUrlDigest: configuredUrlDigest(raw),
  };
}
