import type { ResolvedConfig } from "../config/schema.js";
import type { ProviderManifest } from "../providers/sdk/types.js";
import type { InstalledProviderSummary } from "../providers/registry/sync.js";

export interface ProviderSelectionDecision {
  included: boolean;
  reason: string;
}

function matchesAny(values: readonly string[] | undefined, filters: readonly string[]): boolean {
  return filters.length > 0 && (values ?? []).some((value) => filters.includes(value));
}

export function evaluateProviderInAll(
  config: ResolvedConfig,
  manifest: ProviderManifest,
): ProviderSelectionDecision {
  const inventory = manifest.inventory;
  if (inventory?.entryKind === "view") {
    return { included: false, reason: "view excluded from platform=all" };
  }

  const policy = config.search.selection;
  let included =
    policy.mode === "defaults" ? (inventory?.selection.defaultInAll ?? true) : false;
  let reason = included ? "source default" : `selection mode ${policy.mode}`;

  if (
    matchesAny(inventory?.domains, policy.includeDomains) ||
    matchesAny(inventory?.contentKinds, policy.includeContentKinds) ||
    matchesAny(inventory?.access, policy.includeAccess)
  ) {
    included = true;
    reason = "included by classification";
  }

  if (
    matchesAny(inventory?.domains, policy.excludeDomains) ||
    matchesAny(inventory?.contentKinds, policy.excludeContentKinds) ||
    matchesAny(inventory?.access, policy.excludeAccess)
  ) {
    included = false;
    reason = "excluded by classification";
  }

  if (policy.includeIds.includes(manifest.id)) {
    included = true;
    reason = "included by provider id";
  }
  if (policy.excludeIds.includes(manifest.id)) {
    included = false;
    reason = "excluded by provider id";
  }

  return { included, reason };
}

export function resolveExplicitProvider(
  providers: readonly InstalledProviderSummary[],
  requestedId: string,
): InstalledProviderSummary | undefined {
  const canonical = providers.find((provider) => provider.id === requestedId);
  if (canonical) return canonical;

  const aliases = providers.filter((provider) =>
    provider.manifest?.inventory?.aliases?.includes(requestedId),
  );
  if (aliases.length > 1) {
    throw new Error(
      `Provider alias is ambiguous: ${requestedId} -> ${aliases.map((entry) => entry.id).join(", ")}`,
    );
  }
  return aliases[0];
}
