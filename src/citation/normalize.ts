import type {
  CitationIdentifiers,
  CitationPaper,
  ResourceItem,
} from "../providers/sdk/types.js";
import { CITATION_IDENTIFIER_KINDS } from "../providers/sdk/types.js";
import {
  canonicalCitationKey,
  citationIdentifierAliases,
  normalizeExactIdentifier,
} from "./identifiers.js";
import type {
  CitationCheckpoint,
  CitationEdge,
  CitationEdgeProvenance,
  CitationNode,
} from "./types.js";

interface NormalizedPaperIdentity {
  identifiers: CitationIdentifiers;
  aliases: string[];
  providerNativeId?: string;
  canonicalKey: string;
}

function normalizePaperIdentity(
  paper: CitationPaper,
  providerId: string,
): NormalizedPaperIdentity {
  if (!paper.identifiers || typeof paper.identifiers !== "object" || Array.isArray(paper.identifiers)) {
    throw new Error("citation paper identifiers must be an object");
  }
  const allowedKinds = new Set<string>(CITATION_IDENTIFIER_KINDS);
  const unknownKinds = Object.keys(paper.identifiers).filter((kind) => !allowedKinds.has(kind));
  if (unknownKinds.length > 0) {
    throw new Error(`Unknown citation identifier kind: ${unknownKinds.join(", ")}`);
  }
  const identifiers: CitationIdentifiers = {};
  for (const kind of CITATION_IDENTIFIER_KINDS) {
    const value = paper.identifiers?.[kind];
    if (value !== undefined) identifiers[kind] = normalizeExactIdentifier(kind, value);
  }
  const providerNativeId = paper.providerNativeId?.trim().toLowerCase() || undefined;
  const aliases = citationIdentifierAliases(identifiers);
  if (providerNativeId) aliases.push(`provider:${providerId}:${providerNativeId}`);
  return {
    identifiers,
    aliases,
    providerNativeId,
    canonicalKey: canonicalCitationKey(identifiers, providerId, providerNativeId),
  };
}

function nodeAliases(node: CitationNode): string[] {
  return [
    ...citationIdentifierAliases(node.identifiers),
    ...Object.entries(node.providerNativeIds).map(
      ([providerId, nativeId]) => `provider:${providerId}:${nativeId}`,
    ),
  ];
}

export function resolveCitationKey(
  checkpoint: Pick<CitationCheckpoint, "keyAliases">,
  key: string,
): string {
  let current = key;
  const seen = new Set<string>();
  while (checkpoint.keyAliases[current] && !seen.has(current)) {
    seen.add(current);
    current = checkpoint.keyAliases[current]!;
  }
  return current;
}

function selectDisplayItem(existing: ResourceItem, incoming: ResourceItem): ResourceItem {
  if (!existing.title.trim() && incoming.title.trim()) return incoming;
  return existing;
}

function provenanceKey(provenance: CitationEdgeProvenance): string {
  return JSON.stringify([
    provenance.providerId,
    provenance.providerVersion,
    provenance.targetKeyAtFetch,
    provenance.direction,
    provenance.requestCursor ?? "",
    provenance.observedAt,
    provenance.providerNativeFrom ?? "",
    provenance.providerNativeTo ?? "",
  ]);
}

function edgeId(citingKey: string, citedKey: string): string {
  return `cites:${encodeURIComponent(citingKey)}>${encodeURIComponent(citedKey)}`;
}

function compactEdges(checkpoint: CitationCheckpoint): void {
  const edges = new Map<string, CitationEdge>();
  for (const current of checkpoint.edges) {
    const citingKey = resolveCitationKey(checkpoint, current.citingKey);
    const citedKey = resolveCitationKey(checkpoint, current.citedKey);
    const id = edgeId(citingKey, citedKey);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, { ...current, id, citingKey, citedKey, provenance: [...current.provenance] });
      continue;
    }
    const seen = new Set(existing.provenance.map(provenanceKey));
    for (const provenance of current.provenance) {
      const key = provenanceKey(provenance);
      if (!seen.has(key)) {
        existing.provenance.push(provenance);
        seen.add(key);
      }
    }
  }
  checkpoint.edges = [...edges.values()];
}

function rekeyNode(checkpoint: CitationCheckpoint, oldKey: string, newKey: string): void {
  const resolvedOld = resolveCitationKey(checkpoint, oldKey);
  const resolvedNew = resolveCitationKey(checkpoint, newKey);
  if (resolvedOld === resolvedNew) return;
  checkpoint.keyAliases[resolvedOld] = resolvedNew;
  for (const [alias, target] of Object.entries(checkpoint.keyAliases)) {
    if (target === resolvedOld) checkpoint.keyAliases[alias] = resolvedNew;
  }
}

export interface MergeCitationNodeResult {
  nodeKey: string;
  created: boolean;
}

export function findCitationNodeMatches(
  checkpoint: CitationCheckpoint,
  paper: CitationPaper,
  providerId: string,
): { identity: NormalizedPaperIdentity; matches: CitationNode[] } {
  const identity = normalizePaperIdentity(paper, providerId);
  const incomingAliases = new Set(identity.aliases);
  return {
    identity,
    matches: checkpoint.nodes.filter((node) =>
      nodeAliases(node).some((alias) => incomingAliases.has(alias)),
    ),
  };
}

export function mergeCitationNode(
  checkpoint: CitationCheckpoint,
  paper: CitationPaper,
  providerId: string,
  depthDiscovered: number,
): MergeCitationNodeResult {
  const { identity, matches } = findCitationNodeMatches(checkpoint, paper, providerId);
  if (matches.length === 0) {
    checkpoint.nodes.push({
      key: identity.canonicalKey,
      identifiers: identity.identifiers,
      providerNativeIds: identity.providerNativeId
        ? { [providerId]: identity.providerNativeId }
        : {},
      item: paper.item,
      depthDiscovered,
    });
    return { nodeKey: identity.canonicalKey, created: true };
  }

  const mergedIdentifiers: CitationIdentifiers = {};
  const mergedNativeIds: Record<string, string> = {};
  let item = matches[0]!.item;
  let minimumDepth = depthDiscovered;
  for (const node of matches) {
    for (const kind of CITATION_IDENTIFIER_KINDS) {
      mergedIdentifiers[kind] ??= node.identifiers[kind];
    }
    Object.assign(mergedNativeIds, node.providerNativeIds);
    item = selectDisplayItem(item, node.item);
    minimumDepth = Math.min(minimumDepth, node.depthDiscovered);
  }
  for (const kind of CITATION_IDENTIFIER_KINDS) {
    mergedIdentifiers[kind] ??= identity.identifiers[kind];
  }
  if (identity.providerNativeId) mergedNativeIds[providerId] = identity.providerNativeId;
  item = selectDisplayItem(item, paper.item);
  const canonicalKey = canonicalCitationKey(
    mergedIdentifiers,
    providerId,
    identity.providerNativeId,
  );

  const matchedKeys = new Set(matches.map((node) => node.key));
  checkpoint.nodes = checkpoint.nodes.filter((node) => !matchedKeys.has(node.key));
  checkpoint.nodes.push({
    key: canonicalKey,
    identifiers: mergedIdentifiers,
    providerNativeIds: mergedNativeIds,
    item,
    depthDiscovered: minimumDepth,
  });
  for (const node of matches) rekeyNode(checkpoint, node.key, canonicalKey);
  compactEdges(checkpoint);
  return { nodeKey: canonicalKey, created: false };
}

export function hasCitationEdge(
  checkpoint: CitationCheckpoint,
  citingKey: string,
  citedKey: string,
): boolean {
  const id = edgeId(
    resolveCitationKey(checkpoint, citingKey),
    resolveCitationKey(checkpoint, citedKey),
  );
  return checkpoint.edges.some((edge) => edge.id === id);
}

export function mergeCitationEdge(
  checkpoint: CitationCheckpoint,
  citingKey: string,
  citedKey: string,
  provenance: CitationEdgeProvenance,
): void {
  const resolvedCiting = resolveCitationKey(checkpoint, citingKey);
  const resolvedCited = resolveCitationKey(checkpoint, citedKey);
  const id = edgeId(resolvedCiting, resolvedCited);
  const existing = checkpoint.edges.find((edge) => edge.id === id);
  if (!existing) {
    checkpoint.edges.push({
      id,
      citingKey: resolvedCiting,
      citedKey: resolvedCited,
      relation: "cites",
      provenance: [provenance],
    });
    return;
  }
  const candidateKey = provenanceKey(provenance);
  if (!existing.provenance.some((entry) => provenanceKey(entry) === candidateKey)) {
    existing.provenance.push(provenance);
  }
}

export function sortCitationGraph(checkpoint: CitationCheckpoint): void {
  checkpoint.nodes.sort((left, right) => left.key.localeCompare(right.key));
  checkpoint.edges.sort((left, right) => left.id.localeCompare(right.id));
  for (const edge of checkpoint.edges) {
    edge.provenance.sort((left, right) => provenanceKey(left).localeCompare(provenanceKey(right)));
  }
}
