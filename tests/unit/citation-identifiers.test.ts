import { describe, expect, it } from "vitest";
import {
  canonicalCitationKey,
  normalizeCitationIdentifiers,
  normalizeCitationRequest,
} from "../../src/citation/identifiers.js";
import {
  mergeCitationEdge,
  mergeCitationNode,
  sortCitationGraph,
} from "../../src/citation/normalize.js";
import type { CitationCheckpoint } from "../../src/citation/types.js";

function checkpoint(): CitationCheckpoint {
  return {
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
}

describe("citation exact identifiers", () => {
  it("normalizes exact typed IDs while retaining strict single-ID validation", () => {
    expect(normalizeCitationIdentifiers({ doi: "https://doi.org/10.1000/ABC" })).toEqual({
      doi: "10.1000/abc",
    });
    expect(normalizeCitationIdentifiers({ arxiv: "arXiv:2301.00001v3" })).toEqual({
      arxiv: "2301.00001",
    });
    expect(() =>
      normalizeCitationIdentifiers(
        { doi: "10.1000/abc", semantic: "paper-1" },
        { exactlyOne: true },
      ),
    ).toThrow(/Exactly one/);
    expect(() =>
      normalizeCitationIdentifiers({ semantic: "paper-1", title: "not identity" } as never),
    ).toThrow(/Unknown citation identifier kind/);
  });

  it("coalesces compatible multi-identifier seeds and preserves every exact ID", () => {
    const normalized = normalizeCitationRequest({
      seeds: [
        {
          identifiers: {
            pmid: "00042",
            semantic: "S2-Paper",
          },
          item: { itemType: "journalArticle", title: "Enriched seed" },
        },
        {
          identifiers: {
            doi: "https://doi.org/10.1000/ABC",
            pmid: "42",
          },
        },
        {
          identifiers: { semantic: "other-paper" },
        },
      ],
      excludeIdentifiers: [
        { doi: "10.1000/excluded", semantic: "excluded-paper" },
        { semantic: "EXCLUDED-PAPER", pmid: "0007" },
      ],
    });

    expect(normalized.seeds).toHaveLength(2);
    expect(normalized.seeds[0]).toEqual({
      identifiers: {
        doi: "10.1000/abc",
        pmid: "42",
        semantic: "s2-paper",
      },
      item: { itemType: "journalArticle", title: "Enriched seed" },
    });
    expect(normalized.seeds[1]?.identifiers).toEqual({ semantic: "other-paper" });
    expect(normalized.excludeIdentifiers).toEqual([
      {
        doi: "10.1000/excluded",
        pmid: "7",
        semantic: "excluded-paper",
      },
    ]);

    const reordered = normalizeCitationRequest({
      seeds: [
        { identifiers: { semantic: "other-paper" } },
        { identifiers: { doi: "10.1000/abc", pmid: "42" } },
        {
          identifiers: { semantic: "s2-paper", pmid: "00042" },
          item: { itemType: "journalArticle", title: "Enriched seed" },
        },
      ],
      excludeIdentifiers: [
        { pmid: "7", semantic: "excluded-paper" },
        { semantic: "excluded-paper", doi: "10.1000/excluded" },
      ],
    });
    expect(reordered.seeds).toEqual(normalized.seeds);
    expect(reordered.excludeIdentifiers).toEqual(normalized.excludeIdentifiers);
  });

  it("rejects missing, unsupported, and contradictory seed identities", () => {
    expect(() =>
      normalizeCitationRequest({ seeds: [{ identifiers: {} }] }),
    ).toThrow(/At least one exact citation identifier/);
    expect(() =>
      normalizeCitationRequest({
        seeds: [{ identifiers: { isbn: "978-0-00-000000-0" } as never }],
      }),
    ).toThrow(/Unknown citation identifier kind: isbn/);
    expect(() =>
      normalizeCitationRequest({
        seeds: [
          { identifiers: { doi: "10.1000/shared", semantic: "semantic-a" } },
          { identifiers: { doi: "10.1000/shared", semantic: "semantic-b" } },
        ],
      }),
    ).toThrow(/Contradictory citation seed identifiers for semantic/);
  });

  it("uses identifier priority and never derives identity from display metadata", () => {
    expect(
      canonicalCitationKey({ semantic: "s1", doi: "10.1000/work" }),
    ).toBe("doi:10.1000/work");
    expect(() => canonicalCitationKey({})).toThrow(/no exact/i);
  });

  it("unions nodes only through shared exact IDs and preserves duplicate-edge provenance", () => {
    const graph = checkpoint();
    const seed = mergeCitationNode(
      graph,
      {
        identifiers: { semantic: "seed" },
        item: { itemType: "journalArticle", title: "Seed" },
      },
      "semantic",
      0,
    );
    const first = mergeCitationNode(
      graph,
      {
        identifiers: { semantic: "related" },
        item: { itemType: "journalArticle", title: "Related" },
        providerNativeId: "related",
      },
      "semantic",
      1,
    );
    const enriched = mergeCitationNode(
      graph,
      {
        identifiers: { semantic: "RELATED", doi: "10.1000/related" },
        item: { itemType: "journalArticle", title: "Different display title" },
      },
      "second",
      1,
    );
    expect(enriched.nodeKey).toBe("doi:10.1000/related");
    expect(graph.nodes).toHaveLength(2);

    mergeCitationEdge(graph, seed.nodeKey, first.nodeKey, {
      providerId: "semantic",
      providerVersion: "1.0.0",
      targetKeyAtFetch: seed.nodeKey,
      direction: "backward",
      observedAt: "2026-07-15T00:00:00.000Z",
    });
    mergeCitationEdge(graph, seed.nodeKey, enriched.nodeKey, {
      providerId: "second",
      providerVersion: "2.0.0",
      targetKeyAtFetch: seed.nodeKey,
      direction: "backward",
      observedAt: "2026-07-15T00:01:00.000Z",
    });
    sortCitationGraph(graph);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      citingKey: "semantic:seed",
      citedKey: "doi:10.1000/related",
    });
    expect(graph.edges[0]?.provenance.map((entry) => entry.providerId)).toEqual([
      "second",
      "semantic",
    ]);

    mergeCitationNode(
      graph,
      {
        identifiers: { semantic: "other" },
        item: { itemType: "journalArticle", title: "Related" },
      },
      "semantic",
      1,
    );
    expect(graph.nodes).toHaveLength(3);
  });
});
