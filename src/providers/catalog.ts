import { readCurrentRegistrySnapshot } from "../subscriptions/registry.js";
import { listSubscriptions } from "../subscriptions/service.js";
import type {
  LoadedRegistrySnapshot,
  RegistryCandidateSummary,
  RegistryRuntimeKind,
  SubscriptionIdentity,
} from "../subscriptions/types.js";
import {
  parseRegistryManifest,
  type RegistryInventoryEntry,
} from "./registry/load.js";

export interface AggregatedProviderCandidate extends RegistryCandidateSummary {
  runtimeKind: RegistryRuntimeKind;
  subscriptionId: string;
  sourceFingerprint: string;
  canonicalSource: string;
  registryDigest: string;
  fetchedAt: string;
  ambiguous: boolean;
  sourceCount: number;
}

export interface ProviderCatalogIssue {
  subscriptionId: string;
  reason:
    | "snapshot-missing"
    | "snapshot-invalid"
    | "inventory-missing"
    | "inventory-orphan";
  message: string;
}

export interface AggregatedProviderCatalog {
  query: string | null;
  candidates: AggregatedProviderCandidate[];
  issues: ProviderCatalogIssue[];
}

export interface AvailableSearchInventoryEntry {
  id: string;
  version: string;
  inventory: RegistryInventoryEntry;
  candidateStatus: RegistryCandidateSummary["status"];
  blockedReason?: RegistryCandidateSummary["blockedReason"];
  subscriptionId: string;
  sourceFingerprint: string;
  canonicalSource: string;
  registryDigest: string;
  fetchedAt: string;
  ambiguous: boolean;
  sourceCount: number;
}

export interface AvailableSearchInventoryCatalog {
  entries: AvailableSearchInventoryEntry[];
  issues: ProviderCatalogIssue[];
}

interface ActiveRegistrySnapshot {
  subscriptionId: string;
  runtimeKind: RegistryRuntimeKind;
  identity: SubscriptionIdentity;
  snapshot: LoadedRegistrySnapshot;
}

async function listActiveRegistrySnapshots(
  env: NodeJS.ProcessEnv,
): Promise<{ snapshots: ActiveRegistrySnapshot[]; issues: ProviderCatalogIssue[] }> {
  const subscriptions = await listSubscriptions(env);
  const snapshots: ActiveRegistrySnapshot[] = [];
  const issues: ProviderCatalogIssue[] = [];
  for (const subscription of subscriptions) {
    if (subscription.status !== "active" || !subscription.identity) continue;
    try {
      const snapshot = await readCurrentRegistrySnapshot(
        subscription.id,
        subscription.identity,
        env,
      );
      if (!snapshot) {
        issues.push({
          subscriptionId: subscription.id,
          reason: "snapshot-missing",
          message: `No validated registry snapshot; run registries refresh ${subscription.id}`,
        });
        continue;
      }
      snapshots.push({
        subscriptionId: subscription.id,
        runtimeKind: subscription.runtimeKind,
        identity: subscription.identity,
        snapshot,
      });
    } catch (error) {
      issues.push({
        subscriptionId: subscription.id,
        reason: "snapshot-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { snapshots, issues };
}

export async function listAvailableProviders(
  query?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AggregatedProviderCatalog> {
  const candidates: AggregatedProviderCandidate[] = [];
  const { snapshots, issues } = await listActiveRegistrySnapshots(env);
  for (const { subscriptionId, runtimeKind, identity, snapshot } of snapshots) {
    for (const candidate of snapshot.candidates) {
      candidates.push({
        ...candidate,
        runtimeKind,
        subscriptionId,
        sourceFingerprint: identity.sourceFingerprint,
        canonicalSource: identity.canonicalSource,
        registryDigest: snapshot.summary.registryDigest,
        fetchedAt: snapshot.summary.fetchedAt,
        ambiguous: false,
        sourceCount: 1,
      });
    }
  }

  const sourceCounts = new Map<string, number>();
  for (const candidate of candidates) {
    sourceCounts.set(candidate.id, (sourceCounts.get(candidate.id) ?? 0) + 1);
  }
  const normalizedQuery = query?.trim().toLowerCase() || null;
  const filtered = candidates
    .map((candidate) => {
      const sourceCount = sourceCounts.get(candidate.id) ?? 1;
      return { ...candidate, sourceCount, ambiguous: sourceCount > 1 };
    })
    .filter((candidate) => !normalizedQuery || [
      candidate.id,
      candidate.version,
      candidate.providerKind ?? "",
      candidate.subscriptionId,
      candidate.runtimeKind,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)))
    .sort((left, right) =>
      left.id.localeCompare(right.id) || left.subscriptionId.localeCompare(right.subscriptionId));
  return { query: normalizedQuery, candidates: filtered, issues };
}

export async function listAvailableSearchInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AvailableSearchInventoryCatalog> {
  const { snapshots, issues } = await listActiveRegistrySnapshots(env);
  const entries: AvailableSearchInventoryEntry[] = [];

  for (const { subscriptionId, runtimeKind, identity, snapshot } of snapshots) {
    if (runtimeKind !== "search") continue;
    const manifest = parseRegistryManifest(snapshot.raw);
    const inventoryById = new Map(manifest.inventory.map((entry) => [entry.id, entry]));
    const candidateIds = new Set(snapshot.candidates.map((candidate) => candidate.id));

    for (const candidate of snapshot.candidates) {
      const inventory = inventoryById.get(candidate.id);
      if (!inventory) {
        issues.push({
          subscriptionId,
          reason: "inventory-missing",
          message: `Search registry candidate has no inventory metadata: ${candidate.id}`,
        });
        continue;
      }
      entries.push({
        id: candidate.id,
        version: candidate.version,
        inventory,
        candidateStatus: candidate.status,
        ...(candidate.blockedReason ? { blockedReason: candidate.blockedReason } : {}),
        subscriptionId,
        sourceFingerprint: identity.sourceFingerprint,
        canonicalSource: identity.canonicalSource,
        registryDigest: snapshot.summary.registryDigest,
        fetchedAt: snapshot.summary.fetchedAt,
        ambiguous: false,
        sourceCount: 1,
      });
    }

    for (const inventory of manifest.inventory) {
      if (candidateIds.has(inventory.id)) continue;
      if (inventory.publication.status === "retained-unpublished") continue;
      issues.push({
        subscriptionId,
        reason: "inventory-orphan",
        message: `Search inventory entry is not installable from this snapshot: ${inventory.id}`,
      });
    }
  }

  const sourceCounts = new Map<string, number>();
  for (const entry of entries) {
    sourceCounts.set(entry.id, (sourceCounts.get(entry.id) ?? 0) + 1);
  }
  return {
    entries: entries
      .map((entry) => {
        const sourceCount = sourceCounts.get(entry.id) ?? 1;
        return { ...entry, sourceCount, ambiguous: sourceCount > 1 };
      })
      .sort((left, right) =>
        left.id.localeCompare(right.id) || left.subscriptionId.localeCompare(right.subscriptionId)),
    issues,
  };
}

export async function selectAvailableProvider(options: {
  id: string;
  from?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AggregatedProviderCandidate> {
  const env = options.env ?? process.env;
  const catalog = await listAvailableProviders(undefined, env);
  const matching = catalog.candidates.filter((candidate) =>
    candidate.id === options.id && (!options.from || candidate.subscriptionId === options.from));
  if (matching.length === 0) {
    if (options.from) {
      throw new Error(`Provider ${options.id} is not available from subscription ${options.from}`);
    }
    throw new Error(`Provider is not available in any enabled registry snapshot: ${options.id}`);
  }
  if (matching.length > 1) {
    throw new Error(
      `Provider ${options.id} is available from multiple subscriptions (${matching
        .map((candidate) => candidate.subscriptionId)
        .join(", ")}); select one with --from`,
    );
  }
  return matching[0]!;
}
