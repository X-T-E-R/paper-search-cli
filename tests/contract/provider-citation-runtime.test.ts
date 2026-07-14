import { describe, expect, it } from "vitest";
import { createNodeCompatibilityApi } from "../../src/providers/runtime/createApi.js";
import { invokeProviderFactoryInNode } from "../../src/providers/runtime/invokeNodeFactory.js";
import type { ProviderManifest } from "../../src/providers/sdk/types.js";

const manifest: ProviderManifest = {
  id: "citation_fixture",
  name: "Citation fixture",
  version: "1.0.0",
  sourceType: "academic",
  permissions: { urls: ["https://example.test/*"] },
  capabilities: {
    citationGraph: {
      directions: ["backward", "forward"],
      targetIdentifierKinds: ["semantic"],
      maxPageSize: 100,
    },
  },
};

describe("provider citation runtime", () => {
  it("exposes an optional graph method while keeping legacy providers compatible", async () => {
    const bundle = `
      var __zrs_exports = {
        createProvider() {
          return {
            async search(query) {
              return { platform: "citation_fixture", query, totalResults: 0, items: [], page: 1 };
            },
            async getCitationPage(request) {
              return {
                direction: request.direction,
                target: request.target,
                relations: [{
                  identifiers: { semantic: "B" },
                  item: { itemType: "journalArticle", title: "B" },
                  providerNativeId: "B"
                }],
                exhausted: true,
                observedAt: "2026-07-15T00:00:00.000Z"
              };
            }
          };
        }
      };
    `;
    const loaded = await invokeProviderFactoryInNode(
      bundle,
      manifest,
      createNodeCompatibilityApi({ manifest }),
    );

    expect(loaded.inspection.hasGetCitationPage).toBe(true);
    const target = {
      identifiers: { semantic: "a" },
      item: { itemType: "journalArticle", title: "A" },
    };
    await expect(
      loaded.provider.getCitationPage?.({
        direction: "backward",
        target,
        pageSize: 10,
      }),
    ).resolves.toMatchObject({
      direction: "backward",
      target,
      relations: [{ identifiers: { semantic: "B" } }],
      exhausted: true,
    });
  });
});
