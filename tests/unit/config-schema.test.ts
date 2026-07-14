import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import {
  SearchConfigSchema,
  SearchSelectionConfigSchema,
  SearchSelectorSchema,
  SubscriptionsConfigFileSchema,
} from "../../src/config/schema.js";
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
    expect(() =>
      SearchSelectionConfigSchema.parse({
        mode: "defaults",
        includeIds: ["pubmed"],
        excludeIds: ["pubmed"],
        includeDomains: [],
        excludeDomains: [],
        includeContentKinds: [],
        excludeContentKinds: [],
        includeAccess: [],
        excludeAccess: [],
      }),
    ).toThrow(/both included and excluded/);
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

  it("accepts partial search selection config and rejects conflicting ids", () => {
    expect(
      parseUserConfigDocument({
        schemaVersion: 1,
        search: { selection: { excludeDomains: ["biomedicine"] } },
      }).data,
    ).toEqual({ search: { selection: { excludeDomains: ["biomedicine"] } } });

    expect(() =>
      parseUserConfigDocument({
        schemaVersion: 1,
        search: { selection: { excludeDomains: ["not-a-domain"] } },
      }),
    ).toThrow();
  });

  it("accepts user tags and presets while validating selector and definition names", () => {
    expect(
      parseUserConfigDocument({
        schemaVersion: 1,
        search: {
          defaultAcademicPresets: ["my-general"],
          classifications: {
            "lab-preferred": { sources: ["crossref", "openalex"] },
          },
          presets: {
            "my-general": {
              extends: ["general"],
              include: ["tag:lab-preferred", "source:pubmed"],
              exclude: ["source:semantic"],
            },
          },
        },
      }).data,
    ).toMatchObject({
      search: {
        defaultAcademicPresets: ["my-general"],
        classifications: {
          "lab-preferred": { sources: ["crossref", "openalex"] },
        },
      },
    });
    expect(classifyConfigKey("search.presets.my-general.include")).toBe("non-secret");
    expect(classifyConfigKey("search.classifications.lab-preferred.sources")).toBe("non-secret");

    expect(() => SearchSelectorSchema.parse("domain:not-a-domain")).toThrow(
      /invalid domain selector value/,
    );
    expect(() => SearchSelectorSchema.parse("crossref")).toThrow(/namespace separator/);
    expect(() =>
      parseUserConfigDocument({
        schemaVersion: 1,
        search: { classifications: { "Bad Name": { sources: ["crossref"] } } },
      }),
    ).toThrow();
    expect(() =>
      parseUserConfigDocument({
        schemaVersion: 1,
        search: { presets: { general: { include: ["source:crossref"] } } },
      }),
    ).toThrow(/reserved/);
  });

  it("validates merged preset references, tags, and inheritance cycles", () => {
    expect(
      SearchConfigSchema.parse({
        ...DEFAULT_CONFIG.search,
        defaultAcademicPresets: ["my-general"],
        classifications: { "lab-preferred": { sources: ["crossref"] } },
        presets: {
          "my-general": {
            extends: ["general"],
            include: ["tag:lab-preferred"],
          },
        },
      }).presets["my-general"],
    ).toEqual({
      extends: ["general"],
      include: ["tag:lab-preferred"],
      exclude: [],
    });

    expect(() =>
      SearchConfigSchema.parse({
        ...DEFAULT_CONFIG.search,
        defaultAcademicPresets: ["missing"],
      }),
    ).toThrow(/unknown search preset: missing/);
    expect(() =>
      SearchConfigSchema.parse({
        ...DEFAULT_CONFIG.search,
        presets: { custom: { include: ["tag:missing"] } },
      }),
    ).toThrow(/unknown search tag: missing/);
    expect(() =>
      SearchConfigSchema.parse({
        ...DEFAULT_CONFIG.search,
        presets: {
          alpha: { extends: ["beta"] },
          beta: { extends: ["alpha"] },
        },
      }),
    ).toThrow(/cyclic search preset inheritance/);
  });
});
