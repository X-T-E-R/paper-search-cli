import type {
  CitationIdentifierKind,
  CitationIdentifiers,
  ResourceItem,
} from "../providers/sdk/types.js";
import { CITATION_IDENTIFIER_KINDS } from "../providers/sdk/types.js";
import {
  citationIdentifierAliases,
  ExactIdentifierError,
  normalizeCitationIdentifiers,
  normalizeExactIdentifier,
} from "../identifiers/paper.js";
import type { CitationSeed, NormalizedCitationRequest } from "./types.js";
import { CITATION_LIMITS, CitationServiceError } from "./types.js";

export {
  citationIdentifierAliases,
  ExactIdentifierError,
  normalizeCitationIdentifiers,
  normalizeExactIdentifier,
};

const KEY_PRIORITY: readonly CitationIdentifierKind[] = [
  "doi",
  "semantic",
  "openalex",
  "scopus",
  "pmid",
  "arxiv",
];

export function canonicalCitationKey(
  identifiers: CitationIdentifiers,
  providerId?: string,
  providerNativeId?: string,
): string {
  for (const kind of KEY_PRIORITY) {
    const value = identifiers[kind];
    if (value !== undefined) return `${kind}:${value}`;
  }
  const native = providerNativeId?.trim().toLowerCase();
  if (providerId && native) return `provider:${providerId}:${native}`;
  throw new ExactIdentifierError("Citation paper has no exact typed or provider-native identifier");
}

export function identifierKinds(identifiers: CitationIdentifiers): CitationIdentifierKind[] {
  return CITATION_IDENTIFIER_KINDS.filter((kind) => identifiers[kind] !== undefined);
}

export function projectIdentifiers(
  identifiers: CitationIdentifiers,
  supported: readonly CitationIdentifierKind[],
): CitationIdentifiers {
  const allowed = new Set(supported);
  return Object.fromEntries(
    CITATION_IDENTIFIER_KINDS.flatMap((kind) => {
      const value = identifiers[kind];
      return allowed.has(kind) && value !== undefined ? [[kind, value]] : [];
    }),
  ) as CitationIdentifiers;
}

function defaultSeedItem(identifiers: CitationIdentifiers): ResourceItem {
  const key = canonicalCitationKey(identifiers);
  return { itemType: "journalArticle", title: key, source: "citation-seed" };
}

interface CoalescedIdentifierGroup {
  identifiers: CitationIdentifiers;
  sourceIndexes: number[];
}

function shareExactIdentifier(
  left: CitationIdentifiers,
  right: CitationIdentifiers,
): boolean {
  return CITATION_IDENTIFIER_KINDS.some(
    (kind) => left[kind] !== undefined && left[kind] === right[kind],
  );
}

/**
 * Coalesce records only when an exact typed identifier proves that they refer
 * to the same paper. A bridge may join several groups, but conflicting values
 * for any identifier kind then make the proposed identity ambiguous and are
 * rejected rather than selected by input order.
 */
function coalesceIdentifierRecords(
  records: readonly CitationIdentifiers[],
  label: string,
): CoalescedIdentifierGroup[] {
  let groups: CoalescedIdentifierGroup[] = [];
  records.forEach((identifiers, sourceIndex) => {
    const matches = groups.filter((group) =>
      shareExactIdentifier(group.identifiers, identifiers),
    );
    if (matches.length === 0) {
      groups.push({ identifiers, sourceIndexes: [sourceIndex] });
      return;
    }

    const merged: CitationIdentifiers = {};
    for (const candidate of [identifiers, ...matches.map((group) => group.identifiers)]) {
      for (const kind of CITATION_IDENTIFIER_KINDS) {
        const value = candidate[kind];
        if (value === undefined) continue;
        const existing = merged[kind];
        if (existing !== undefined && existing !== value) {
          throw new ExactIdentifierError(
            `Contradictory ${label} identifiers for ${kind}: ${existing} and ${value}`,
          );
        }
        merged[kind] = value;
      }
    }

    const matched = new Set(matches);
    groups = groups.filter((group) => !matched.has(group));
    groups.push({
      identifiers: merged,
      sourceIndexes: [
        ...matches.flatMap((group) => group.sourceIndexes),
        sourceIndex,
      ].sort((left, right) => left - right),
    });
  });

  return groups.sort((left, right) =>
    canonicalCitationKey(left.identifiers).localeCompare(
      canonicalCitationKey(right.identifiers),
    ),
  );
}

function validateBound(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CitationServiceError(
      "invalid_request",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function normalizeCitationRequest(input: {
  seeds: CitationSeed[];
  directions?: NormalizedCitationRequest["directions"];
  providers?: string[];
  excludeIdentifiers?: CitationIdentifiers[];
  limits?: Partial<NormalizedCitationRequest["limits"]>;
}): NormalizedCitationRequest {
  if (!Array.isArray(input.seeds) || input.seeds.length < 1 || input.seeds.length > CITATION_LIMITS.seeds) {
    throw new CitationServiceError(
      "invalid_request",
      `seeds must contain 1..${CITATION_LIMITS.seeds} entries`,
    );
  }
  let seeds: NormalizedCitationRequest["seeds"];
  try {
    const normalizedSeeds = input.seeds.map((seed) => {
      if (!seed || typeof seed !== "object" || !seed.identifiers) {
        throw new ExactIdentifierError("Each citation seed must contain typed identifiers");
      }
      const identifiers = normalizeCitationIdentifiers(seed.identifiers);
      if (
        seed.item !== undefined &&
        (!seed.item || typeof seed.item !== "object" || typeof seed.item.title !== "string")
      ) {
        throw new ExactIdentifierError("Citation seed item must contain a display title");
      }
      return { identifiers, item: seed.item };
    });
    seeds = coalesceIdentifierRecords(
      normalizedSeeds.map((seed) => seed.identifiers),
      "citation seed",
    ).map((group) => {
      const explicitItem = group.sourceIndexes
        .map((sourceIndex) => normalizedSeeds[sourceIndex]!.item)
        .find((item) => item !== undefined);
      return {
        identifiers: group.identifiers,
        // Display metadata is never merge authority. Preserve the first explicit
        // record for a coalesced identity, or derive a stable identifier label.
        item: explicitItem ?? defaultSeedItem(group.identifiers),
      };
    });
  } catch (error) {
    throw new CitationServiceError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
  const directions = input.directions ?? ["backward", "forward"];
  if (
    !Array.isArray(directions) ||
    directions.length === 0 ||
    new Set(directions).size !== directions.length ||
    directions.some((direction) => direction !== "backward" && direction !== "forward")
  ) {
    throw new CitationServiceError(
      "invalid_request",
      "directions must contain unique backward/forward values",
    );
  }
  if (input.providers !== undefined && !Array.isArray(input.providers)) {
    throw new CitationServiceError("invalid_request", "providers must be an array");
  }
  const requestedProviders = input.providers?.map((entry) =>
    typeof entry === "string" ? entry.trim() : "",
  );
  if (
    requestedProviders &&
    (requestedProviders.length === 0 ||
      requestedProviders.some((entry) => !/^[a-z][a-z0-9_-]{1,63}$/u.test(entry)) ||
      new Set(requestedProviders).size !== requestedProviders.length)
  ) {
    throw new CitationServiceError("invalid_request", "providers must contain unique provider IDs");
  }
  let excludeIdentifiers: CitationIdentifiers[];
  try {
    if (input.excludeIdentifiers !== undefined && !Array.isArray(input.excludeIdentifiers)) {
      throw new ExactIdentifierError("excludeIdentifiers must be an array");
    }
    excludeIdentifiers = coalesceIdentifierRecords(
      (input.excludeIdentifiers ?? []).map((entry) =>
        normalizeCitationIdentifiers(entry),
      ),
      "excluded citation",
    ).map((group) => group.identifiers);
  } catch (error) {
    throw new CitationServiceError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
  const seedAliases = new Set(seeds.flatMap((seed) => citationIdentifierAliases(seed.identifiers)));
  if (excludeIdentifiers.some((entry) => citationIdentifierAliases(entry).some((alias) => seedAliases.has(alias)))) {
    throw new CitationServiceError("invalid_request", "A citation seed cannot also be excluded");
  }
  const limits = input.limits ?? {};
  return {
    seeds,
    directions: [...directions],
    requestedProviders,
    excludeIdentifiers,
    limits: {
      depth: validateBound("limits.depth", limits.depth ?? CITATION_LIMITS.depth.default, 0, CITATION_LIMITS.depth.max),
      perNode: validateBound("limits.perNode", limits.perNode ?? CITATION_LIMITS.perNode.default, 1, CITATION_LIMITS.perNode.max),
      nodes: validateBound("limits.nodes", limits.nodes ?? CITATION_LIMITS.nodes.default, seeds.length, CITATION_LIMITS.nodes.max),
      edges: validateBound("limits.edges", limits.edges ?? CITATION_LIMITS.edges.default, 1, CITATION_LIMITS.edges.max),
      providerPages: validateBound("limits.providerPages", limits.providerPages ?? CITATION_LIMITS.providerPages.default, 1, CITATION_LIMITS.providerPages.max),
      concurrency: validateBound("limits.concurrency", limits.concurrency ?? CITATION_LIMITS.concurrency.default, 1, CITATION_LIMITS.concurrency.max),
    },
  };
}
