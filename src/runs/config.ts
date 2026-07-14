import type { ResolvedConfig } from "../config/schema.js";
import { openResearchRunStore, type ResearchRunStore, type RunStoreOptions } from "./store.js";

export type ConfiguredRunStoreResolver = (
  config: ResolvedConfig,
) => ResearchRunStore | Promise<ResearchRunStore>;

export async function openRunStoreFromResolvedConfig(
  config: ResolvedConfig,
): Promise<ResearchRunStore> {
  const options: RunStoreOptions = {
    root: config.runs.root,
    maxAgeDays: config.runs.maxAgeDays,
  };
  return openResearchRunStore(options);
}
