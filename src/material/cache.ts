import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";

/**
 * Material-provider cache is replaceable machine state owned by the conventional
 * Paper Search home, never by a workspace or an explicit project config.
 */
export function resolveMaterialProviderCacheRoot(
  config: Pick<ResolvedConfig, "meta">,
): string {
  return path.join(path.dirname(path.resolve(config.meta.userConfigPath)), "cache", "material");
}
