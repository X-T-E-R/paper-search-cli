import type {
  CitationDirection,
  CitationPaper,
} from "../providers/sdk/types.js";
import {
  canonicalCitationKey,
  citationIdentifierAliases,
  projectIdentifiers,
} from "./identifiers.js";
import {
  findCitationNodeMatches,
  hasCitationEdge,
  mergeCitationEdge,
  mergeCitationNode,
  resolveCitationKey,
  sortCitationGraph,
} from "./normalize.js";
import type {
  CitationAttempt,
  CitationCapStop,
  CitationCheckpoint,
  CitationEdgeProvenance,
  CitationProviderRuntime,
  CitationProviderSnapshot,
  CitationWorkUnit,
  NormalizedCitationRequest,
} from "./types.js";

export interface CitationTraversalProgress {
  checkpoint: CitationCheckpoint;
  attempt: CitationAttempt;
  diagnostic?: { code: string; message: string };
}

interface ExecuteCitationTraversalInput {
  request: NormalizedCitationRequest;
  selectedProviders: readonly CitationProviderSnapshot[];
  providers: readonly CitationProviderRuntime[];
  checkpoint: CitationCheckpoint;
  now: () => Date;
  onProgress(progress: CitationTraversalProgress): Promise<void>;
}

function workKey(work: CitationWorkUnit, checkpoint: CitationCheckpoint): string {
  return JSON.stringify([
    resolveCitationKey(checkpoint, work.nodeKey),
    work.direction,
    work.providerId,
    work.cursor ?? "",
  ]);
}

function sortWork(
  work: CitationWorkUnit[],
  request: NormalizedCitationRequest,
  providers: readonly CitationProviderSnapshot[],
  checkpoint: CitationCheckpoint,
): void {
  const directionOrder = new Map(request.directions.map((value, index) => [value, index]));
  const providerOrder = new Map(providers.map((value, index) => [value.providerId, index]));
  work.sort((left, right) =>
    left.depth - right.depth ||
    resolveCitationKey(checkpoint, left.nodeKey).localeCompare(resolveCitationKey(checkpoint, right.nodeKey)) ||
    (directionOrder.get(left.direction) ?? 99) - (directionOrder.get(right.direction) ?? 99) ||
    (providerOrder.get(left.providerId) ?? 99) - (providerOrder.get(right.providerId) ?? 99) ||
    (left.cursor ?? "").localeCompare(right.cursor ?? ""),
  );
}

function enqueueUnique(checkpoint: CitationCheckpoint, work: CitationWorkUnit): void {
  const candidateKey = workKey(work, checkpoint);
  if (
    checkpoint.pending.some((entry) => workKey(entry, checkpoint) === candidateKey) ||
    checkpoint.completed.some((entry) => workKey(entry, checkpoint) === candidateKey)
  ) return;
  checkpoint.pending.push(work);
}

function addCapStop(checkpoint: CitationCheckpoint, stop: CitationCapStop): void {
  const key = JSON.stringify(stop);
  if (!checkpoint.capStops.some((entry) => JSON.stringify(entry) === key)) {
    checkpoint.capStops.push(stop);
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/([?&](?:api[-_]?key|token|secret|password)=)[^&#\s]+/giu, "$1[redacted]")
    .slice(0, 1_000);
}

function validatePage(
  page: unknown,
  work: CitationWorkUnit,
  requestPageSize: number,
  checkpoint: CitationCheckpoint,
  providerId: string,
): asserts page is Awaited<ReturnType<CitationProviderRuntime["getCitationPage"]>> {
  if (!page || typeof page !== "object") throw new Error("provider page must be an object");
  const value = page as Record<string, unknown>;
  if (value.direction !== work.direction) throw new Error("provider page direction does not match request");
  if (!Array.isArray(value.relations)) throw new Error("provider page relations must be an array");
  if (value.relations.length > requestPageSize) throw new Error("provider page exceeds requested pageSize");
  if (typeof value.exhausted !== "boolean") throw new Error("provider page exhausted must be boolean");
  if (typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error("provider page observedAt must be an ISO timestamp");
  }
  if (
    value.nextCursor !== undefined &&
    (typeof value.nextCursor !== "string" || value.nextCursor.length === 0)
  ) throw new Error("provider page nextCursor must be a non-empty string");
  if (value.exhausted && value.nextCursor !== undefined) {
    throw new Error("exhausted provider page cannot return nextCursor");
  }
  if (!value.exhausted && value.nextCursor === undefined) {
    throw new Error("non-exhausted provider page must return nextCursor");
  }
  if (value.nextCursor !== undefined && value.nextCursor === work.cursor) {
    throw new Error("provider page repeated its request cursor");
  }
  if (!value.target || typeof value.target !== "object") throw new Error("provider page target is required");
  const pageTarget = value.target as CitationPaper;
  if (!pageTarget.item || typeof pageTarget.item !== "object" || typeof pageTarget.item.title !== "string") {
    throw new Error("provider page target item must include a title");
  }
  const targetMatches = findCitationNodeMatches(
    checkpoint,
    pageTarget,
    providerId,
  ).matches;
  const requestedTargetKey = resolveCitationKey(checkpoint, work.nodeKey);
  if (!targetMatches.some((node) => resolveCitationKey(checkpoint, node.key) === requestedTargetKey)) {
    throw new Error("provider page target does not match the requested exact identifier");
  }
  for (const relation of value.relations) {
    if (!relation || typeof relation !== "object") throw new Error("citation relation must be an object");
    const paper = relation as CitationPaper;
    if (!paper.item || typeof paper.item !== "object" || typeof paper.item.title !== "string") {
      throw new Error("citation relation item must include a title");
    }
    findCitationNodeMatches(checkpoint, paper, providerId);
  }
}

function toTargetPaper(
  checkpoint: CitationCheckpoint,
  work: CitationWorkUnit,
  provider: CitationProviderRuntime,
): CitationPaper {
  const nodeKey = resolveCitationKey(checkpoint, work.nodeKey);
  const node = checkpoint.nodes.find((entry) => entry.key === nodeKey);
  if (!node || !provider.capability) throw new Error(`Missing graph node or provider capability: ${nodeKey}`);
  const identifiers = projectIdentifiers(
    node.identifiers,
    provider.capability.targetIdentifierKinds,
  );
  if (Object.keys(identifiers).length === 0) {
    throw new Error(`Provider ${provider.id} cannot target node ${nodeKey} by exact identifier`);
  }
  return {
    identifiers,
    item: node.item,
    providerNativeId: node.providerNativeIds[provider.id],
  };
}

function providerSupportsNode(
  checkpoint: CitationCheckpoint,
  nodeKey: string,
  provider: CitationProviderRuntime,
): boolean {
  if (!provider.capability) return false;
  const resolved = resolveCitationKey(checkpoint, nodeKey);
  const node = checkpoint.nodes.find((entry) => entry.key === resolved);
  return !!node && Object.keys(projectIdentifiers(node.identifiers, provider.capability.targetIdentifierKinds)).length > 0;
}

function isExcluded(
  paper: CitationPaper,
  providerId: string,
  excludedAliases: ReadonlySet<string>,
  checkpoint: CitationCheckpoint,
): boolean {
  const { identity } = findCitationNodeMatches(checkpoint, paper, providerId);
  return identity.aliases.some((alias) => excludedAliases.has(alias));
}

function initialPaper(seed: NormalizedCitationRequest["seeds"][number]): CitationPaper {
  return { identifiers: seed.identifiers, item: seed.item };
}

export function createInitialCitationCheckpoint(
  request: NormalizedCitationRequest,
  selectedProviders: readonly CitationProviderSnapshot[],
): CitationCheckpoint {
  const checkpoint: CitationCheckpoint = {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    keyAliases: {},
    pending: [],
    completed: [],
    providerPages: 0,
    successfulPages: 0,
    capStops: [],
  };
  for (const seed of request.seeds) mergeCitationNode(checkpoint, initialPaper(seed), "seed", 0);
  if (request.limits.depth === 0) {
    sortCitationGraph(checkpoint);
    return checkpoint;
  }
  for (const node of checkpoint.nodes) {
    for (const direction of request.directions) {
      for (const provider of selectedProviders) {
        if (
          provider.citationGraph.directions.includes(direction) &&
          Object.keys(projectIdentifiers(node.identifiers, provider.citationGraph.targetIdentifierKinds)).length > 0
        ) {
          enqueueUnique(checkpoint, {
            depth: 0,
            nodeKey: node.key,
            direction,
            providerId: provider.providerId,
            fetchedRelations: 0,
          });
        }
      }
    }
  }
  sortWork(checkpoint.pending, request, selectedProviders, checkpoint);
  return checkpoint;
}

export async function executeCitationTraversal(
  input: ExecuteCitationTraversalInput,
): Promise<{ attempts: CitationAttempt[]; diagnostics: Array<{ code: string; message: string }> }> {
  const { request, selectedProviders, checkpoint, now, onProgress } = input;
  const providersById = new Map(input.providers.map((provider) => [provider.id, provider]));
  const snapshotsById = new Map(selectedProviders.map((provider) => [provider.providerId, provider]));
  const excludedAliases = new Set(request.excludeIdentifiers.flatMap(citationIdentifierAliases));
  const deferred: CitationWorkUnit[] = [];
  const attempts: CitationAttempt[] = [];
  const diagnostics: Array<{ code: string; message: string }> = [];
  let globalStop = false;
  const persistenceView = (): CitationCheckpoint => ({
    ...checkpoint,
    pending: [...checkpoint.pending, ...deferred],
  });

  while (checkpoint.pending.length > 0 && !globalStop) {
    sortWork(checkpoint.pending, request, selectedProviders, checkpoint);
    if (checkpoint.providerPages >= request.limits.providerPages) {
      addCapStop(checkpoint, { kind: "provider_pages", limit: request.limits.providerPages });
      break;
    }
    const work = checkpoint.pending.shift()!;
    work.nodeKey = resolveCitationKey(checkpoint, work.nodeKey);
    const provider = providersById.get(work.providerId);
    const snapshot = snapshotsById.get(work.providerId);
    const startedAt = now().toISOString();
    checkpoint.providerPages += 1;
    if (!provider || !snapshot) {
      const finishedAt = now().toISOString();
      const attempt: CitationAttempt = {
        providerId: work.providerId,
        providerVersion: snapshot?.providerVersion ?? "unknown",
        nodeKey: work.nodeKey,
        direction: work.direction,
        cursor: work.cursor,
        startedAt,
        finishedAt,
        outcome: "error",
        errorCode: "provider_error",
        error: "Selected citation provider runtime is unavailable",
      };
      attempts.push(attempt);
      deferred.push(work);
      const diagnostic = { code: "provider_error", message: `${work.providerId}: ${attempt.error}` };
      diagnostics.push(diagnostic);
      await onProgress({ checkpoint: persistenceView(), attempt, diagnostic });
      continue;
    }

    const pageSize = Math.min(
      request.limits.perNode - work.fetchedRelations,
      snapshot.citationGraph.maxPageSize,
    );
    try {
      const target = toTargetPaper(checkpoint, work, provider);
      const page = await provider.getCitationPage({
        direction: work.direction,
        target,
        pageSize,
        cursor: work.cursor,
      });
      validatePage(page, work, pageSize, checkpoint, provider.id);
      if (page.nextCursor) {
        const nextKey = workKey({ ...work, cursor: page.nextCursor }, checkpoint);
        if (
          checkpoint.completed.some((entry) => workKey(entry, checkpoint) === nextKey) ||
          checkpoint.pending.some((entry) => workKey(entry, checkpoint) === nextKey)
        ) {
          throw new Error("provider page cursor repeats already scheduled or completed work");
        }
      }
      const targetKeyAtFetch = work.nodeKey;
      const discoveredKeys = new Set<string>();
      for (const related of page.relations) {
        if (isExcluded(related, provider.id, excludedAliases, checkpoint)) continue;
        const before = findCitationNodeMatches(checkpoint, related, provider.id);
        const existingKey = before.matches[0]?.key ?? before.identity.canonicalKey;
        const targetKey = resolveCitationKey(checkpoint, work.nodeKey);
        const prospectiveCiting = work.direction === "backward" ? targetKey : existingKey;
        const prospectiveCited = work.direction === "backward" ? existingKey : targetKey;
        if (!hasCitationEdge(checkpoint, prospectiveCiting, prospectiveCited) && checkpoint.edges.length >= request.limits.edges) {
          addCapStop(checkpoint, { kind: "edges", limit: request.limits.edges });
          globalStop = true;
          break;
        }
        if (before.matches.length === 0 && checkpoint.nodes.length >= request.limits.nodes) {
          addCapStop(checkpoint, { kind: "nodes", limit: request.limits.nodes });
          globalStop = true;
          break;
        }
        const merged = mergeCitationNode(checkpoint, related, provider.id, work.depth + 1);
        work.nodeKey = resolveCitationKey(checkpoint, work.nodeKey);
        const citingKey = work.direction === "backward" ? work.nodeKey : merged.nodeKey;
        const citedKey = work.direction === "backward" ? merged.nodeKey : work.nodeKey;
        const provenance: CitationEdgeProvenance = {
          providerId: provider.id,
          providerVersion: provider.version,
          targetKeyAtFetch,
          direction: work.direction,
          requestCursor: work.cursor,
          observedAt: page.observedAt,
          providerNativeFrom:
            work.direction === "backward"
              ? target.providerNativeId
              : related.providerNativeId,
          providerNativeTo:
            work.direction === "backward"
              ? related.providerNativeId
              : target.providerNativeId,
        };
        mergeCitationEdge(checkpoint, citingKey, citedKey, provenance);
        discoveredKeys.add(resolveCitationKey(checkpoint, merged.nodeKey));
      }

      work.fetchedRelations += page.relations.length;
      checkpoint.completed.push(work);
      checkpoint.successfulPages += 1;
      if (!globalStop && page.nextCursor && work.fetchedRelations < request.limits.perNode) {
        enqueueUnique(checkpoint, { ...work, cursor: page.nextCursor });
      } else if (!globalStop && page.nextCursor) {
        addCapStop(checkpoint, {
          kind: "per_node",
          nodeKey: work.nodeKey,
          providerId: provider.id,
          limit: request.limits.perNode,
        });
      }
      if (!globalStop && work.depth + 1 < request.limits.depth) {
        for (const nodeKey of [...discoveredKeys].sort((left, right) => left.localeCompare(right))) {
          for (const direction of request.directions) {
            for (const nextSnapshot of selectedProviders) {
              const nextProvider = providersById.get(nextSnapshot.providerId);
              if (
                nextProvider &&
                nextSnapshot.citationGraph.directions.includes(direction) &&
                providerSupportsNode(checkpoint, nodeKey, nextProvider)
              ) {
                enqueueUnique(checkpoint, {
                  depth: work.depth + 1,
                  nodeKey,
                  direction,
                  providerId: nextProvider.id,
                  fetchedRelations: 0,
                });
              }
            }
          }
        }
      }
      sortCitationGraph(checkpoint);
      const finishedAt = now().toISOString();
      const attempt: CitationAttempt = {
        providerId: provider.id,
        providerVersion: provider.version,
        nodeKey: targetKeyAtFetch,
        direction: work.direction,
        cursor: work.cursor,
        startedAt,
        finishedAt,
        outcome: "success",
        relationCount: page.relations.length,
        exhausted: page.exhausted,
      };
      attempts.push(attempt);
      await onProgress({ checkpoint: persistenceView(), attempt });
    } catch (error) {
      const message = safeErrorMessage(error);
      const errorCode = /provider page|citation relation|exhausted|cursor|pageSize/iu.test(message)
        ? "invalid_provider_page"
        : "provider_error";
      const finishedAt = now().toISOString();
      const attempt: CitationAttempt = {
        providerId: provider.id,
        providerVersion: provider.version,
        nodeKey: work.nodeKey,
        direction: work.direction,
        cursor: work.cursor,
        startedAt,
        finishedAt,
        outcome: "error",
        errorCode,
        error: message,
      };
      attempts.push(attempt);
      deferred.push(work);
      const diagnostic = { code: errorCode, message: `${provider.id}: ${message}` };
      diagnostics.push(diagnostic);
      await onProgress({ checkpoint: persistenceView(), attempt, diagnostic });
    }
  }
  for (const work of deferred) enqueueUnique(checkpoint, work);
  sortWork(checkpoint.pending, request, selectedProviders, checkpoint);
  sortCitationGraph(checkpoint);
  return { attempts, diagnostics };
}
