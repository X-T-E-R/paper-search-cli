import { readFileSync } from "node:fs";

declare const __PAPER_SEARCH_VERSION__: string | undefined;

interface PackageJsonLike {
  version?: unknown;
}

let cachedVersion: string | null = null;

export function getSystemVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  if (
    typeof __PAPER_SEARCH_VERSION__ !== "undefined" &&
    typeof __PAPER_SEARCH_VERSION__ === "string" &&
    __PAPER_SEARCH_VERSION__.trim()
  ) {
    cachedVersion = __PAPER_SEARCH_VERSION__;
    return cachedVersion;
  }
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as PackageJsonLike;
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error("package.json version is missing or invalid");
  }
  cachedVersion = parsed.version;
  return cachedVersion;
}

export function semverCompare(left: string, right: string): number {
  const a = left
    .split(/[-+]/)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const b = right
    .split(/[-+]/)[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function semverGte(version: string, minimum: string): boolean {
  return semverCompare(version, minimum) >= 0;
}
