import type { CitationIdentifierKind } from "../providers/sdk/types.js";
import { canonicalCitationKey, identifierKinds } from "./identifiers.js";
import type {
  CitationPlan,
  CitationProviderPlanEntry,
  CitationProviderRuntime,
  CitationProviderSnapshot,
  NormalizedCitationRequest,
} from "./types.js";

function supportsAnySeedKind(
  targetKinds: readonly CitationIdentifierKind[],
  seedKinds: readonly CitationIdentifierKind[],
): boolean {
  const supported = new Set(targetKinds);
  return seedKinds.some((kind) => supported.has(kind));
}

export function planCitationExpansion(
  request: NormalizedCitationRequest,
  providers: readonly CitationProviderRuntime[],
): CitationPlan {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const selectedIds = request.requestedProviders
    ? [...request.requestedProviders]
    : providers
        .filter((provider) => provider.available && provider.capability)
        .map((provider) => provider.id)
        .sort((left, right) => left.localeCompare(right));
  const selectedSet = new Set(selectedIds);
  const orderedIds = [
    ...selectedIds,
    ...providers
      .map((provider) => provider.id)
      .filter((id) => !selectedSet.has(id))
      .sort((left, right) => left.localeCompare(right)),
  ];
  const entries: CitationProviderPlanEntry[] = [];
  const selectedProviders: CitationProviderSnapshot[] = [];
  const warnings: string[] = [];
  let plannedWorkUnits = 0;

  for (const providerId of orderedIds) {
    const selected = selectedSet.has(providerId);
    const provider = providersById.get(providerId);
    if (!provider) {
      entries.push({
        providerId,
        selected,
        available: false,
        supported: false,
        eligibleSeedCount: 0,
        reasons: ["provider package is not installed or valid"],
      });
      continue;
    }
    const capability = provider.capability;
    const reasons = [...provider.unavailableReasons];
    if (!capability) reasons.push("provider does not declare citationGraph capability");
    const eligibleSeeds = capability
      ? request.seeds.filter((seed) =>
          supportsAnySeedKind(capability.targetIdentifierKinds, identifierKinds(seed.identifiers)),
        )
      : [];
    if (capability && eligibleSeeds.length === 0) {
      reasons.push("provider cannot target any seed identifier kind");
    }
    const supportedDirections = capability
      ? request.directions.filter((direction) => capability.directions.includes(direction))
      : [];
    if (capability && supportedDirections.length === 0) {
      reasons.push("provider supports none of the requested directions");
    }
    const runnable =
      selected && provider.available && !!capability && eligibleSeeds.length > 0 && supportedDirections.length > 0;
    if (runnable) {
      selectedProviders.push({
        providerId,
        providerVersion: provider.version,
        citationGraph: {
          directions: [...capability.directions],
          targetIdentifierKinds: [...capability.targetIdentifierKinds],
          maxPageSize: capability.maxPageSize,
        },
      });
      plannedWorkUnits += eligibleSeeds.length * supportedDirections.length;
      const unsupportedDirections = request.directions.filter(
        (direction) => !capability.directions.includes(direction),
      );
      if (unsupportedDirections.length > 0) {
        warnings.push(
          `${providerId} does not support requested direction(s): ${unsupportedDirections.join(", ")}`,
        );
      }
      if (eligibleSeeds.length < request.seeds.length) {
        warnings.push(
          `${providerId} cannot target ${request.seeds.length - eligibleSeeds.length} seed(s) by exact identifier`,
        );
      }
    } else if (selected) {
      warnings.push(`${providerId}: ${reasons.join("; ") || "provider is not runnable"}`);
    }
    entries.push({
      providerId,
      providerVersion: provider.version,
      selected,
      available: provider.available,
      supported: !!capability,
      eligibleSeedCount: eligibleSeeds.length,
      reasons,
      capability,
    });
  }

  const seedKeys = request.seeds.map((seed) => canonicalCitationKey(seed.identifiers));
  if (new Set(seedKeys).size !== seedKeys.length) {
    warnings.push("duplicate exact seeds are coalesced into one traversal node");
  }

  return {
    mode: "plan",
    request,
    providers: entries,
    selectedProviders,
    plannedWorkUnits,
    warnings: [...new Set(warnings)],
  };
}
