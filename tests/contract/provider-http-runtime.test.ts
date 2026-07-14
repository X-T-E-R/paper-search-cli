import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNodeCompatibilityApi,
  ProviderHttpError,
  resetProviderRateLimitStateForTests,
  type ProviderHttpTransport,
} from "../../src/providers/runtime/createApi.js";
import type { ProviderManifest } from "../../src/providers/sdk/types.js";

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "runtime-http-fixture",
    name: "Runtime HTTP Fixture",
    version: "1.0.0",
    sourceType: "academic",
    permissions: { urls: ["https://allowed.example/*"] },
    ...overrides,
  };
}

function successTransport(): ProviderHttpTransport {
  return {
    async get<T = unknown>() {
      return { data: {} as T, status: 200, statusText: "OK", headers: {} };
    },
    async post<T = unknown>() {
      return { data: {} as T, status: 200, statusText: "OK", headers: {} };
    },
  };
}

beforeEach(() => {
  resetProviderRateLimitStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider HTTP runtime contract", () => {
  it("enforces URL permissions around injected transports", async () => {
    let getCalls = 0;
    const api = createNodeCompatibilityApi({
      manifest: manifest(),
      transport: {
        ...successTransport(),
        async get<T = unknown>() {
          getCalls += 1;
          return { data: {} as T, status: 200, statusText: "OK", headers: {} };
        },
      },
    });

    await expect(api.http.get("https://forbidden.example/data")).rejects.toThrow(
      "URL not allowed by provider permissions",
    );
    expect(getCalls).toBe(0);
  });

  it("rejects non-2xx JSON and text responses with bounded provider context", async () => {
    const responses = [
      { data: { message: "rate limited" }, status: 429, statusText: "Too Many Requests" },
      { data: "upstream exploded", status: 503, statusText: "Service Unavailable" },
    ];
    let index = 0;
    const api = createNodeCompatibilityApi({
      manifest: manifest(),
      transport: {
        async get<T = unknown>() {
          const response = responses[index++]!;
          return { ...response, data: response.data as T, headers: {} };
        },
        async post() {
          throw new Error("not used");
        },
      },
    });

    await expect(api.http.get("https://allowed.example/one")).rejects.toMatchObject({
      name: "ProviderHttpError",
      providerId: "runtime-http-fixture",
      status: 429,
    } satisfies Partial<ProviderHttpError>);
    await expect(api.http.get("https://allowed.example/two")).rejects.toThrow(
      /503 Service Unavailable.*upstream exploded/,
    );
  });

  it("does not follow redirects outside the declared URL permission", async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response("", {
        status: 302,
        statusText: "Found",
        headers: { location: "https://forbidden.example/redirected" },
      });
    });
    const api = createNodeCompatibilityApi({ manifest: manifest() });

    await expect(api.http.get("https://allowed.example/start")).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 302,
    });
    expect(requestInit?.redirect).toBe("manual");
  });

  it("exposes only manifest-allowlisted global preferences", () => {
    const api = createNodeCompatibilityApi({
      manifest: manifest({ allowedGlobalPrefs: ["api.allowed.key"] }),
      globalPrefs: {
        "api.allowed.key": "visible",
        "api.private.key": "secret",
        "api.allowed.count": 7,
      },
    });

    expect(api.getGlobalPref("api.allowed.key", "fallback")).toBe("visible");
    expect(api.getGlobalPref("api.private.key", "fallback")).toBe("fallback");
    expect(api.getGlobalPrefNumber("api.allowed.count", 3)).toBe(3);
  });

  it("shares request scheduling across runtime instances and avoids double waits", async () => {
    const waits: number[] = [];
    const hooks = {
      stateKey: "shared-rate-test",
      now: () => 0,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
    };
    const rateManifest = manifest({ rateLimitPerMinute: 60 });
    const first = createNodeCompatibilityApi({
      manifest: rateManifest,
      transport: successTransport(),
      rateLimit: hooks,
    });
    const second = createNodeCompatibilityApi({
      manifest: rateManifest,
      transport: successTransport(),
      rateLimit: hooks,
    });

    await Promise.all([
      first.http.get("https://allowed.example/first"),
      second.http.get("https://allowed.example/second"),
    ]);
    await second.rateLimit.acquire();
    await second.http.get("https://allowed.example/third");

    expect(waits).toEqual([1000, 2000]);
  });
});
