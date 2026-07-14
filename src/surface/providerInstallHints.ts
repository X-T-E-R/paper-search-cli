import path from "node:path";
import { sanitizeUrlForDisplay } from "../runtime/sanitizeUrl.js";
import {
  OFFICIAL_MATERIAL_REGISTRY_URL,
  OFFICIAL_SEARCH_REGISTRY_URL,
} from "../subscriptions/source.js";

export interface ProviderInstallCounts {
  search: { total: number; valid: number };
  material: { total: number; valid: number };
}

export function summarizeOnboardingInstallCounts(
  searchProviders: ReadonlyArray<{ valid: boolean; path: string }>,
  materialProviders: ReadonlyArray<{ valid: boolean; path: string }>,
): ProviderInstallCounts {
  const validSearchPaths = new Set(
    searchProviders.filter((entry) => entry.valid).map((entry) => path.resolve(entry.path)),
  );
  const validMaterialPaths = new Set(
    materialProviders.filter((entry) => entry.valid).map((entry) => path.resolve(entry.path)),
  );
  const relevantSearch = searchProviders.filter(
    (entry) => entry.valid || !validMaterialPaths.has(path.resolve(entry.path)),
  );
  const relevantMaterial = materialProviders.filter(
    (entry) => entry.valid || !validSearchPaths.has(path.resolve(entry.path)),
  );
  return {
    search: {
      total: relevantSearch.length,
      valid: relevantSearch.filter((entry) => entry.valid).length,
    },
    material: {
      total: relevantMaterial.length,
      valid: relevantMaterial.filter((entry) => entry.valid).length,
    },
  };
}

export function sanitizeRegistrySource(source: string): string {
  return sanitizeUrlForDisplay(source);
}

export function buildZeroProviderWarnings(
  registryUrl: string,
  counts: ProviderInstallCounts,
): string[] {
  const warnings: string[] = [];
  const registry = registryUrl.trim();

  if (counts.search.valid === 0) {
    warnings.push(
      `No search providers are installed; academic and patent search are unavailable. ` +
        `Add the visible official trust source with registries add official-search ${OFFICIAL_SEARCH_REGISTRY_URL} ` +
        `--kind search --apply, then run registries refresh official-search and providers available. ` +
        `The legacy one-off compatibility source remains ${registry}; it is not a bound subscription.`,
    );
  }

  if (counts.material.valid === 0) {
    warnings.push(
      `No material providers are installed; material ingest and extract need material runtime packages. ` +
        `Add the exact registry JSON URL with registries add official-material ${OFFICIAL_MATERIAL_REGISTRY_URL} ` +
        `--kind material --apply, then run registries refresh official-material and providers available. ` +
        `Provider installation stays plan-first through providers install <id> --from official-material.`,
    );
  }

  return warnings;
}
