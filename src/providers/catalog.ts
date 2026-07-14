import { readCurrentRegistrySnapshot } from "../subscriptions/registry.js";
import { listSubscriptions } from "../subscriptions/service.js";
import type { RegistryCandidateSummary, RegistryRuntimeKind } from "../subscriptions/types.js";

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
  reason: "snapshot-missing" | "snapshot-invalid";
  message: string;
}

export interface AggregatedProviderCatalog {
  query: string | null;
  candidates: AggregatedProviderCandidate[];
  issues: ProviderCatalogIssue[];
}

export async function listAvailableProviders(
  query?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AggregatedProviderCatalog> {
  const subscriptions = await listSubscriptions(env);
  const candidates: AggregatedProviderCandidate[] = [];
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
      for (const candidate of snapshot.candidates) {
        candidates.push({
          ...candidate,
          runtimeKind: subscription.runtimeKind,
          subscriptionId: subscription.id,
          sourceFingerprint: subscription.identity.sourceFingerprint,
          canonicalSource: subscription.identity.canonicalSource,
          registryDigest: snapshot.summary.registryDigest,
          fetchedAt: snapshot.summary.fetchedAt,
          ambiguous: false,
          sourceCount: 1,
        });
      }
    } catch (error) {
      issues.push({
        subscriptionId: subscription.id,
        reason: "snapshot-invalid",
        message: error instanceof Error ? error.message : String(error),
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
