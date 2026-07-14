import type { ResolvedConfig } from "../config/schema.js";
import { listInstalledProviders } from "../providers/registry/sync.js";
import { resolveProviderAvailability } from "../providers/runtime/availability.js";
import { loadProviderRuntimeFromSummary } from "../search/runtime.js";
import type { CitationProviderRuntime } from "./types.js";

/**
 * Creates lazy graph runtimes from the existing installed search-provider
 * registry. Listing/plan reads manifests only; provider code is loaded only
 * when traversal requests a page.
 */
export async function createInstalledCitationProviderRuntimes(
  config: ResolvedConfig,
): Promise<CitationProviderRuntime[]> {
  const installed = await listInstalledProviders(config.providers.installDir);
  const runtimes: CitationProviderRuntime[] = [];
  for (const summary of installed) {
    const manifest = summary.manifest;
    if (!summary.valid || !manifest || manifest.sourceType !== "academic") continue;
    const availability = resolveProviderAvailability(config, manifest);
    let loaded: ReturnType<typeof loadProviderRuntimeFromSummary> | undefined;
    const getLoaded = () => {
      loaded ??= loadProviderRuntimeFromSummary(config, summary);
      return loaded;
    };
    runtimes.push({
      id: manifest.id,
      version: manifest.version,
      available: availability.available,
      unavailableReasons: [
        ...(availability.enabled ? [] : ["provider is disabled"]),
        ...availability.missingConfigKeys.map((key) => `missing required config: ${key}`),
      ],
      capability: manifest.capabilities?.citationGraph,
      async getCitationPage(request) {
        if (!availability.available) {
          throw new Error(
            `Provider ${manifest.id} is unavailable: ${[
              ...(availability.enabled ? [] : ["provider is disabled"]),
              ...availability.missingConfigKeys.map((key) => `missing required config: ${key}`),
            ].join("; ")}`,
          );
        }
        const runtime = await getLoaded();
        if (!runtime.provider.getCitationPage) {
          throw new Error(
            `Provider ${manifest.id} declares citationGraph but does not implement getCitationPage()`,
          );
        }
        return runtime.provider.getCitationPage(request);
      },
    });
  }
  return runtimes.sort((left, right) => left.id.localeCompare(right.id));
}
