import type { RunCanonicalToolOptions } from "../surface/toolRunner.js";

export function compactCanonicalArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

export function cliHistoryOptions(
  options: Record<string, unknown>,
): Pick<RunCanonicalToolOptions, "recordHistory"> {
  return options.history === false ? { recordHistory: false } : {};
}
