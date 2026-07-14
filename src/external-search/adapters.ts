import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ExternalSearchError } from "./errors.js";

export const EXTERNAL_SEARCH_ADAPTER_NAME = /^[a-z][a-z0-9_-]{0,62}$/u;

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveExternalSearchAdapter(configRoot: string, name: string): Promise<string> {
  if (name === "native" || !EXTERNAL_SEARCH_ADAPTER_NAME.test(name)) {
    throw new ExternalSearchError("adapter_invalid", `Invalid external search adapter name: ${name}`);
  }
  const adaptersDirectory = path.join(configRoot, "adapters");
  const candidate = path.join(adaptersDirectory, `${name}.mjs`);
  try {
    const [rootReal, adaptersReal, candidateReal, candidateStat] = await Promise.all([
      realpath(configRoot),
      realpath(adaptersDirectory),
      realpath(candidate),
      stat(candidate),
    ]);
    if (!candidateStat.isFile()) {
      throw new ExternalSearchError("adapter_invalid", `External search adapter is not a regular file: ${candidate}`);
    }
    if (!isContained(rootReal, adaptersReal)) {
      throw new ExternalSearchError("adapter_invalid", "External search adapters directory escapes the user config root");
    }
    if (!isContained(adaptersReal, candidateReal)) {
      throw new ExternalSearchError("adapter_invalid", `External search adapter escapes the adapters directory: ${name}`);
    }
    return candidateReal;
  } catch (error) {
    if (error instanceof ExternalSearchError) throw error;
    throw new ExternalSearchError("adapter_invalid", `External search adapter is unavailable: ${name}`, { cause: error });
  }
}
