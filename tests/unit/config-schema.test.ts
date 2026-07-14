import { describe, expect, it } from "vitest";
import { SubscriptionsConfigFileSchema } from "../../src/config/schema.js";
import {
  classifyConfigKey,
  parseCredentialsConfigDocument,
  parseUserConfigDocument,
} from "../../src/config/userConfig.js";

describe("strict split-config schemas", () => {
  it("accepts only v1 stable-id subscription records", () => {
    expect(
      SubscriptionsConfigFileSchema.parse({
        schemaVersion: 1,
        subscriptions: {
          "official-search": {
            runtimeKind: "search",
            url: "https://example.test/registry.json",
            enabled: true,
          },
        },
      }),
    ).toMatchObject({ schemaVersion: 1 });

    expect(() =>
      SubscriptionsConfigFileSchema.parse({
        schemaVersion: 1,
        subscriptions: {
          "Bad/Id": {
            runtimeKind: "search",
            url: "https://example.test/registry.json",
            enabled: true,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      SubscriptionsConfigFileSchema.parse({
        schemaVersion: 2,
        subscriptions: {},
      }),
    ).toThrow();
  });

  it("rejects unknown config keys and non-secret credential entries", () => {
    expect(() =>
      parseUserConfigDocument({ schemaVersion: 1, unknownNamespace: { enabled: true } }),
    ).toThrow();
    expect(() =>
      parseCredentialsConfigDocument({
        schemaVersion: 1,
        api: { tavily: { enabled: true } },
      }),
    ).toThrow(/non-secret or ambiguous/);
    expect(
      parseCredentialsConfigDocument({
        schemaVersion: 1,
        api: { tavily: { apiKey: "secret" } },
      }),
    ).toEqual({ api: { tavily: { apiKey: "secret" } } });
  });

  it("uses installed-provider descriptors before the conservative name rule", () => {
    const metadata = {
      "platform.fixture.sessionCookie": "secret" as const,
      "platform.fixture.password": "non-secret" as const,
    };
    expect(classifyConfigKey("platform.fixture.sessionCookie", metadata)).toBe("secret");
    expect(classifyConfigKey("platform.fixture.password", metadata)).toBe("non-secret");
    expect(
      parseCredentialsConfigDocument(
        {
          schemaVersion: 1,
          platform: { fixture: { sessionCookie: "opaque" } },
        },
        metadata,
      ),
    ).toEqual({ platform: { fixture: { sessionCookie: "opaque" } } });
  });
});
