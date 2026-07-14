import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProviderPackage } from "../../src/providers/package/load.js";
import { createNodeCompatibilityApi } from "../../src/providers/runtime/createApi.js";
import { invokeProviderFactoryInNode } from "../../src/providers/runtime/invokeNodeFactory.js";

const fixturePackagePath = path.resolve(
  "tests",
  "fixtures",
  "provider-packages",
  "fixture-academic",
);

describe("provider package runtime", () => {
  it("loads a provider package and executes search in Node compatibility mode", async () => {
    const providerPackage = await loadProviderPackage(fixturePackagePath);
    const api = createNodeCompatibilityApi({
      manifest: providerPackage.manifest,
      providerConfig: { label: "fixture" },
      transport: {
        async get<T = unknown>() {
          return {
            data: {
              totalResults: 1,
              items: [{ itemType: "journalArticle", title: "Fixture Result" }],
            } as T,
            status: 200,
            statusText: "OK",
            headers: {},
          };
        },
        async post() {
          throw new Error("not used");
        },
      },
    });

    const loaded = await invokeProviderFactoryInNode(
      providerPackage.bundleCode,
      providerPackage.manifest,
      api,
    );

    expect(loaded.inspection).toEqual({ hasSearch: true, hasGetDetail: false });
    const result = await loaded.provider.search("retrieval augmented generation", {
      maxResults: 5,
      page: 2,
    });
    expect(result.platform).toBe("fixture-academic");
    expect(result.page).toBe(2);
    expect(result.items[0]?.title).toBe("Fixture Result");
  });

  it("does not expose raw fetch in the provider compatibility namespace", async () => {
    const providerPackage = await loadProviderPackage(fixturePackagePath);
    const bundleCode = `
      var __zrs_exports = {
        createProvider() {
          return {
            async search(query) {
              return {
                platform: "raw-fetch-probe",
                query,
                totalResults: 0,
                items: [],
                page: 1,
                error: typeof fetch
              };
            }
          };
        }
      };
    `;
    const api = createNodeCompatibilityApi({ manifest: providerPackage.manifest });
    const loaded = await invokeProviderFactoryInNode(
      bundleCode,
      providerPackage.manifest,
      api,
    );

    const result = await loaded.provider.search("probe");
    expect(result.error).toBe("undefined");
  });
});
