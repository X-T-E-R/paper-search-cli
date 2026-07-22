import type { ResolvedConfig } from "../config/schema.js";
import {
  openResearchRunStore,
  RunStoreError,
  type ResearchRunStore,
  type RunStoreOptions,
} from "./store.js";
import { readRunLocator, registerRunLocator } from "./locator.js";
import type { ResearchRunRecord } from "./types.js";

export type ConfiguredRunStoreResolver = (
  config: ResolvedConfig,
) => ResearchRunStore | Promise<ResearchRunStore>;

export async function openRunStoreFromResolvedConfig(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResearchRunStore> {
  const options: RunStoreOptions = {
    root: config.runs.root,
    maxAgeDays: config.runs.maxAgeDays,
    onCreated: async (record, root) => registerRunLocator(config, record.runId, root, env),
  };
  return openResearchRunStore(options);
}

export interface LocatedRun {
  record: ResearchRunRecord;
  root: string;
  located: boolean;
}

export async function readRunFromConfiguredOrLocatedStore(
  config: ResolvedConfig,
  runId: string,
  resolveConfiguredStore: ConfiguredRunStoreResolver = openRunStoreFromResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocatedRun> {
  const configured = await resolveConfiguredStore(config);
  try {
    return { record: await configured.read(runId), root: configured.root, located: false };
  } catch (error) {
    if (!(error instanceof RunStoreError) || error.code !== "run_not_found") {
      throw error;
    }
  }
  const locator = await readRunLocator(runId, env);
  if (!locator) throw new RunStoreError("run_not_found", `Run not found: ${runId}`);
  const located = await openResearchRunStore({
    root: locator.runRoot,
    maxAgeDays: config.runs.maxAgeDays,
  });
  try {
    return { record: await located.read(runId), root: located.root, located: true };
  } catch (error) {
    if (error instanceof RunStoreError && error.code === "run_not_found") {
      throw new RunStoreError("run_not_found", `Run locator is stale: ${runId}`, { cause: error });
    }
    throw error;
  }
}
