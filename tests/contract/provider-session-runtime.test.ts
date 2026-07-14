import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProviderPackage } from "../../src/providers/package/load.js";
import { createNodeCompatibilityApi } from "../../src/providers/runtime/createApi.js";
import { invokeProviderFactoryInNode } from "../../src/providers/runtime/invokeNodeFactory.js";

const fixturePackagePath = path.resolve(
  "tests",
  "fixtures",
  "provider-packages",
  "fixture-patent-session",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider session runtime", () => {
  it("persists cookies across withCredentials requests and supports getDetail", async () => {
    const requests: Array<{ url: string; cookie: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers ?? {});
        const cookie = headers.get("cookie") ?? "";
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ url, cookie, body });

        if (url === "https://fixture.example/login") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: [
              ["content-type", "application/json"],
              ["set-cookie", "SESSION=fixture-session; Path=/; HttpOnly"],
            ],
          });
        }

        if (url === "https://fixture.example/search") {
          if (!cookie.includes("SESSION=fixture-session")) {
            return new Response(JSON.stringify({ ok: false, error: "missing session cookie" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                platform: "fixture-patent-session",
                query: "graphene sensor",
                totalResults: 1,
                items: [
                  {
                    itemType: "patent",
                    title: "Graphene Sensor Patent",
                    patentNumber: "CN-123",
                    sourceId: "PAT-001",
                    source: "fixture-patent-session",
                  },
                ],
                page: 1,
                hasMore: false,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url === "https://fixture.example/detail") {
          if (!cookie.includes("SESSION=fixture-session")) {
            return new Response(JSON.stringify({ ok: false, error: "missing session cookie" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                item: {
                  itemType: "patent",
                  title: "Graphene Sensor Patent",
                  patentNumber: "CN-123",
                  sourceId: "PAT-001",
                  source: "fixture-patent-session",
                },
                detail: {
                  legalStatus: {
                    available: true,
                    entries: [{ date: "2024-01-02", status: "valid", info: "granted" }],
                  },
                  claims: {
                    available: true,
                    text: "1. A graphene sensor...",
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const providerPackage = await loadProviderPackage(fixturePackagePath);
    const api = createNodeCompatibilityApi({
      manifest: providerPackage.manifest,
      providerConfig: {
        loginName: "fixture-user",
        password: "fixture-pass",
      },
    });

    const loaded = await invokeProviderFactoryInNode(
      providerPackage.bundleCode,
      providerPackage.manifest,
      api,
    );

    expect(loaded.inspection).toEqual({ hasSearch: true, hasGetDetail: true });
    const searchResult = await loaded.provider.search("graphene sensor", {
      maxResults: 5,
      page: 1,
    });
    const detailResult = await loaded.provider.getDetail?.("PAT-001", {
      include: ["legalStatus", "claims"],
    });

    expect(searchResult.items[0]?.title).toBe("Graphene Sensor Patent");
    expect(detailResult?.detail.claims?.text).toContain("graphene sensor");
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://fixture.example/login", cookie: "" }),
        expect.objectContaining({
          url: "https://fixture.example/search",
          cookie: expect.stringContaining("SESSION=fixture-session"),
        }),
        expect.objectContaining({
          url: "https://fixture.example/detail",
          cookie: expect.stringContaining("SESSION=fixture-session"),
        }),
      ]),
    );
  });
});
