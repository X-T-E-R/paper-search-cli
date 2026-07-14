import type { ResolvedConfig } from "../config/schema.js";
import {
  listAvailableSearchInventory,
  type AvailableSearchInventoryEntry,
} from "../providers/catalog.js";
import {
  listInstalledProviders,
  type InstalledProviderSummary,
} from "../providers/registry/sync.js";
import type { ProviderInventoryEntry, ProviderManifest } from "../providers/sdk/types.js";
import type { ProviderSelectionCandidate } from "./selection.js";

export interface ProviderSelectionCandidateSet {
  installed: InstalledProviderSummary[];
  candidates: ProviderSelectionCandidate[];
  warnings: string[];
}

function catalogManifest(entry: AvailableSearchInventoryEntry): ProviderManifest {
  const inventory: ProviderInventoryEntry = {
    schemaVersion: 1,
    ...entry.inventory,
  };
  return {
    id: entry.id,
    name: entry.id,
    version: entry.version,
    sourceType: inventory.sourceType,
    permissions: { urls: [] },
    inventory,
  };
}

function inventorySignature(entry: AvailableSearchInventoryEntry): string {
  return JSON.stringify(entry.inventory);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function listProviderSelectionCandidates(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderSelectionCandidateSet> {
  const installed = await listInstalledProviders(config.providers.installDir);
  let catalog: Awaited<ReturnType<typeof listAvailableSearchInventory>>;
  try {
    catalog = await listAvailableSearchInventory(env);
  } catch (error) {
    return {
      installed,
      candidates: installed.map((entry) => ({ ...entry, installed: true })),
      warnings: [
        `Search registry catalog is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  const catalogById = new Map<string, AvailableSearchInventoryEntry[]>();
  for (const entry of catalog.entries) {
    const matches = catalogById.get(entry.id) ?? [];
    matches.push(entry);
    catalogById.set(entry.id, matches);
  }

  const candidates: ProviderSelectionCandidate[] = [];
  const warnings = catalog.issues.map(
    (issue) => `Registry ${issue.subscriptionId}: ${issue.message}`,
  );

  for (const installedProvider of installed) {
    if (installedProvider.manifest) {
      candidates.push({ ...installedProvider, installed: true });
      continue;
    }
    const catalogEntries = catalogById.get(installedProvider.id) ?? [];
    candidates.push({ ...installedProvider, installed: true });
    if (catalogEntries.length > 0) {
      warnings.push(
        `Installed provider ${installedProvider.id} is invalid; registry classification was ignored`,
      );
    }
  }

  for (const [id, catalogEntries] of catalogById) {
    if (installedById.has(id)) continue;
    const signatures = new Set(catalogEntries.map(inventorySignature));
    if (signatures.size > 1) {
      warnings.push(
        `Active registry snapshots disagree on classification for uninstalled provider ${id}: ${uniqueSorted(catalogEntries.map((entry) => entry.subscriptionId)).join(", ")}`,
      );
      continue;
    }
    const representative = catalogEntries[0]!;
    const sourceIds = uniqueSorted(catalogEntries.map((entry) => entry.subscriptionId));
    const catalogReadinessReasons = [
      ...(sourceIds.length > 1
        ? [`provider is available from multiple subscriptions: ${sourceIds.join(", ")}`]
        : []),
      ...catalogEntries
        .filter((entry) => entry.candidateStatus === "blocked")
        .map((entry) =>
          `catalog candidate is blocked${entry.blockedReason ? `: ${entry.blockedReason}` : ""}`),
    ];
    candidates.push({
      id,
      version: representative.version,
      installed: false,
      valid: true,
      manifest: catalogManifest(representative),
      catalogReadinessReasons: uniqueSorted(catalogReadinessReasons),
    });
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id));
  return { installed, candidates, warnings: uniqueSorted(warnings) };
}
