import { randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { removeInstallPath } from "./cleanup.js";

export interface InstallPathReplacementOperations {
  rename(source: string, destination: string): Promise<void>;
  stat(targetPath: string): Promise<unknown>;
  remove(targetPath: string): Promise<void>;
}

export interface InstallPathRetention {
  stagingRoot: string;
  finalRoot: string;
}

export interface InstallPathSelectionOptions {
  validateSelected?: (targetPath: string) => Promise<void>;
  /** Verify retained rollback/selection authority before the transaction commits. */
  validateCommitted?: (targetPath: string) => Promise<void>;
  retention?: InstallPathRetention;
  restoreStagingOnFailure?: boolean;
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
} & InstallPathSelectionOptions): Promise<{
  replacedExisting: boolean;
  retainedBackupPath?: string;
}> {
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

  const retention = options.retention
    ? {
        stagingRoot: path.resolve(options.retention.stagingRoot),
        finalRoot: path.resolve(options.retention.finalRoot),
      }
    : undefined;
  if (
    retention &&
    path.dirname(retention.stagingRoot) !== path.dirname(retention.finalRoot)
  ) {
    throw new Error("Provider rollback staging and final paths must share a parent directory");
  }
  if (retention && !replacedExisting) {
    throw new Error("Provider rollback retention requires an existing install");
  }

  if (replacedExisting) await operations.rename(targetPath, backupPath);
  let selected = false;
  let restorableBackupPath = backupPath;
  try {
    await operations.rename(stagingPath, targetPath);
    selected = true;
    await options.validateSelected?.(targetPath);

    if (replacedExisting && retention) {
      const stagedProviderPath = path.join(retention.stagingRoot, "provider");
      await operations.rename(backupPath, stagedProviderPath);
      restorableBackupPath = stagedProviderPath;
      await operations.rename(retention.stagingRoot, retention.finalRoot);
      restorableBackupPath = path.join(retention.finalRoot, "provider");
      await options.validateCommitted?.(targetPath);
      return {
        replacedExisting: true,
        retainedBackupPath: path.join(retention.finalRoot, "provider"),
      };
    }

    await options.validateCommitted?.(targetPath);
    // The selected target is authoritative. A stale backup is recoverable and
    // must not turn a successful replacement into a reported install failure.
    if (replacedExisting) await operations.remove(backupPath).catch(() => undefined);
    return { replacedExisting };
  } catch (installError) {
    const restoreErrors: unknown[] = [];
    let backupRestored = !replacedExisting;
    if (selected) {
      try {
        if (options.restoreStagingOnFailure) {
          await operations.rename(targetPath, stagingPath);
        } else {
          await operations.remove(targetPath);
        }
      } catch (error) {
        restoreErrors.push(error);
      }
    }
    if (replacedExisting) {
      try {
        await operations.rename(restorableBackupPath, targetPath);
        backupRestored = true;
      } catch (error) {
        restoreErrors.push(error);
      }
    }
    if (retention) {
      await operations.remove(retention.stagingRoot).catch(() => undefined);
      if (backupRestored) await operations.remove(retention.finalRoot).catch(() => undefined);
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [installError, ...restoreErrors],
        `Failed to install ${options.providerId} and restore the previous provider`,
      );
    }
    throw installError;
  }
}
