import { access, rename, rm } from "node:fs/promises";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function replaceDirectoryWithPrevious({
  nextPath,
  currentPath,
  previousPath,
}) {
  // A crash after current -> previous is recovered deterministically before a
  // new candidate is considered. Never select `nextPath` over an interrupted
  // previous runtime.
  if (!(await exists(currentPath)) && (await exists(previousPath))) {
    await rename(previousPath, currentPath);
  }

  const hasCurrent = await exists(currentPath);
  if (hasCurrent) {
    // Old previous can be removed safely only while current remains selected.
    await rm(previousPath, { recursive: true, force: true });
    await rename(currentPath, previousPath);
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (hasCurrent) {
      try {
        await rename(previousPath, currentPath);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Failed to install or restore directory");
      }
    }
    throw error;
  }

}
