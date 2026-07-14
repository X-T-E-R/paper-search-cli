import { randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { removeInstallPath } from "./cleanup.js";

export interface InstallPathReplacementOperations {
  rename(source: string, destination: string): Promise<void>;
  stat(targetPath: string): Promise<unknown>;
  remove(targetPath: string): Promise<void>;
}

const defaultOperations: InstallPathReplacementOperations = {
  rename,
  stat,
  remove: removeInstallPath,
};

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Atomically selects a fully materialized provider directory. Existing content
 * is first renamed to a same-directory backup and restored if selection fails.
 */
export async function replaceInstallPath(options: {
  stagingPath: string;
  targetPath: string;
  providerId: string;
  operations?: InstallPathReplacementOperations;
}): Promise<{ replacedExisting: boolean }> {
  const operations = options.operations ?? defaultOperations;
  const stagingPath = path.resolve(options.stagingPath);
  const targetPath = path.resolve(options.targetPath);
  if (path.dirname(stagingPath) !== path.dirname(targetPath)) {
    throw new Error("Provider staging and target paths must share a parent directory");
  }

  const replacedExisting = await operations.stat(targetPath).then(
    () => true,
    (error: unknown) => {
      if (isMissingPath(error)) return false;
      throw error;
    },
  );
  const backupPath = path.join(
    path.dirname(targetPath),
    `.${options.providerId}.backup.${randomUUID()}`,
  );

  if (replacedExisting) await operations.rename(targetPath, backupPath);
  try {
    await operations.rename(stagingPath, targetPath);
  } catch (installError) {
    if (replacedExisting) {
      try {
        await operations.rename(backupPath, targetPath);
      } catch (restoreError) {
        throw new AggregateError(
          [installError, restoreError],
          `Failed to install ${options.providerId} and restore the previous provider`,
        );
      }
    }
    throw installError;
  }

  // The selected target is authoritative. A stale backup is recoverable and
  // must not turn a successful replacement into a reported install failure.
  if (replacedExisting) await operations.remove(backupPath).catch(() => undefined);
  return { replacedExisting };
}
