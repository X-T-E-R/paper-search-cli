import { chmod, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export function isReadonlyDeleteFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("read only") ||
    normalized.includes("readonly") ||
    normalized.includes("access denied") ||
    normalized.includes("access rights") ||
    normalized.includes("拒绝访问") ||
    normalized.includes("eperm")
  );
}

async function makePathWritable(targetPath: string): Promise<void> {
  const info = await stat(targetPath);
  await chmod(targetPath, info.isDirectory() ? 0o755 : 0o644);
  if (!info.isDirectory()) {
    return;
  }
  const entries = await readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => makePathWritable(path.join(targetPath, entry.name))),
  );
}

export async function removeInstallPath(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (!isReadonlyDeleteFailure(error)) {
      throw error;
    }
    await makePathWritable(targetPath);
    await rm(targetPath, { recursive: true, force: true });
  }
}
