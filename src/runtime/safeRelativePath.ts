import path from "node:path";

export type UnsafePathHandler = (message: string) => never;

const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function throwUnsafePath(message: string): never {
  throw new Error(message);
}

export function assertSafeRelativePath(
  relativePath: string,
  label = "provider package path",
  fail: UnsafePathHandler = throwUnsafePath,
): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[. ]$/u.test(segment) ||
        /[\u0000-\u001f]/u.test(segment) ||
        WINDOWS_RESERVED_SEGMENT_RE.test(segment),
    )
  ) {
    fail(`Unsafe ${label}: ${relativePath}`);
  }
  return normalized;
}

export function resolveSafePathInsideRoot(
  root: string,
  relativePath: string,
  label = "provider package path",
  fail: UnsafePathHandler = throwUnsafePath,
): { relativePath: string; absolutePath: string } {
  const normalized = assertSafeRelativePath(relativePath, label, fail);
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, normalized);
  const relativeToRoot = path.relative(resolvedRoot, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    fail(`${label} escapes install root: ${relativePath}`);
  }
  return { relativePath: normalized, absolutePath };
}
