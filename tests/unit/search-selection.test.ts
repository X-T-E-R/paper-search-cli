import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import type { InstalledProviderSummary } from "../../src/providers/registry/sync.js";
import type {
  ProviderInventoryEntry,
  ProviderManifest,
  SourceType,
} from "../../src/providers/sdk/types.js";
import {
  resolveProviderSelection,
  type ProviderSelectionCandidate,
} from "../../src/search/selection.js";

function createConfig(): ResolvedConfig {
  const config = structuredClone(DEFAULT_CONFIG) as Omit<ResolvedConfig, "meta">;
  Object.assign(config.search, {
    defaultAcademicPresets: ["general"],
    defaultPatentPresets: ["patents"],
    classifications: {},
    presets: {},
  });
  return {
    ...config,
    meta: {
      cwd: "/workspace",
      userConfigPath: "/config/config.toml",
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
}

function inventory(options: {
  id: string;
  sourceType?: "academic" | "patent";
  entryKind?: "source" | "view";
  domains?: ProviderInventoryEntry["domains"];
  contentKinds?: ProviderInventoryEntry["contentKinds"];
  access?: ProviderInventoryEntry["access"];
  aliases?: string[];
}): ProviderInventoryEntry {
  const entryKind = options.entryKind ?? "source";
  return {
    schemaVersion: 1,
    id: options.id,
    kind: "search",
    sourceType: options.sourceType ?? "academic",
    entryKind,
    ...(entryKind === "source"
      ? { sourceId: `example.${options.id}` }
      : { backingSourceIds: ["example.crossref"] }),
    aliases: options.aliases,
    serviceFamily: `example.${options.id}.api`,
    transport: "api",
    domains: options.domains ?? ["multidisciplinary"],
    contentKinds: options.contentKinds ?? ["journal-article"],
    access: options.access ?? ["public"],
    selection: { defaultInAll: false },
    publication: { status: "published" },
  };
}

function provider(options: {
  id: string;
  sourceType?: SourceType;
  entryKind?: "source" | "view";
  domains?: ProviderInventoryEntry["domains"];
  contentKinds?: ProviderInventoryEntry["contentKinds"];
  access?: ProviderInventoryEntry["access"];
  aliases?: string[];
  requiredConfig?: string;
  installed?: boolean;
}): InstalledProviderSummary & ProviderSelectionCandidate {
  const sourceType = options.sourceType ?? "academic";
  const manifest: ProviderManifest = {
    id: options.id,
    name: options.id,
    version: "1.0.0",
    sourceType,
    permissions: { urls: ["https://example.test/*"] },
    ...(options.requiredConfig
      ? {
          configSchema: {
            [options.requiredConfig]: { type: "string", required: true },
          },
        }
      : {}),
    ...(sourceType === "academic" || sourceType === "patent"
      ? {
          inventory: inventory({
            id: options.id,
            sourceType,
            entryKind: options.entryKind,
            domains: options.domains,
            contentKinds: options.contentKinds,
            access: options.access,
            aliases: options.aliases,
          }),
        }
      : {}),
  };
  return {
    id: options.id,
    version: "1.0.0",
    path: `/providers/${options.id}`,
    layout: "kind",
    installed: options.installed,
    valid: true,
    manifest,
  };
}

describe("provider selection", () => {
  it("keeps comprehensive membership independent from credentials and readiness", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "zjusummon" }),
      provider({
        id: "wos",
        access: ["credentialed", "institutional"],
        requiredConfig: "apiKey",
      }),
      provider({ id: "dblp", domains: ["computer-science"] }),
    ];

    const before = resolveProviderSelection(config, "academic", providers);
    expect(before.selectedProviderIds).toEqual(["wos", "zjusummon"]);
    expect(before.runnableProviderIds).toEqual(["zjusummon"]);
    expect(before.skippedProviderIds).toEqual(["wos"]);
    expect(before.entries.find((entry) => entry.id === "wos")).toMatchObject({
      selected: true,
      configured: false,
      readinessReasons: ["missing required config: apiKey"],
    });

    config.platform.wos = { apiKey: "fixture-key" };
    const after = resolveProviderSelection(config, "academic", providers);
    expect(after.selectedProviderIds).toEqual(before.selectedProviderIds);
    expect(after.runnableProviderIds).toEqual(["wos", "zjusummon"]);
  });

  it("treats explicit all as every runnable non-view source instead of general", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "zjusummon" }),
      provider({ id: "dblp", domains: ["computer-science"] }),
      provider({ id: "wos", requiredConfig: "apiKey" }),
      provider({ id: "acm", entryKind: "view", domains: ["computer-science"] }),
    ];

    const plan = resolveProviderSelection(config, "academic", providers, { platform: "all" });
    expect(plan.usedDefaults).toBe(false);
    expect(plan.selectedProviderIds).toEqual(["dblp", "zjusummon"]);
    expect(plan.runnableProviderIds).toEqual(["dblp", "zjusummon"]);
    expect(plan.entries.find((entry) => entry.id === "acm")?.selected).toBe(false);
    expect(plan.entries.find((entry) => entry.id === "wos")).toMatchObject({
      selected: false,
      configured: false,
    });
  });

  it("keeps snapshot-known preset members selected when their package is not installed", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "openalex" }),
      provider({ id: "zjusummon", installed: false }),
    ];

    const defaults = resolveProviderSelection(config, "academic", providers);
    expect(defaults.selectedProviderIds).toEqual(["openalex", "zjusummon"]);
    expect(defaults.runnableProviderIds).toEqual(["openalex"]);
    expect(defaults.entries.find((entry) => entry.id === "zjusummon")).toMatchObject({
      installed: false,
      selected: true,
      runnable: false,
      readinessReasons: ["provider package is not installed"],
    });

    const all = resolveProviderSelection(config, "academic", providers, { platform: "all" });
    expect(all.selectedProviderIds).toEqual(["openalex"]);
  });

  it("unions positive selectors while exact exclusions remain final", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "openalex" }),
      provider({ id: "dblp", domains: ["computer-science"] }),
      provider({ id: "pubmed", domains: ["biomedicine"] }),
    ];

    const plan = resolveProviderSelection(config, "academic", providers, {
      presets: ["general"],
      categories: ["domain:computer-science"],
      sources: ["pubmed"],
      excludeCategories: ["domain:biomedicine"],
      excludeSources: ["dblp"],
    });

    expect(plan.runnableProviderIds).toEqual(["openalex", "pubmed"]);
    expect(plan.entries.find((entry) => entry.id === "dblp")).toMatchObject({
      selected: false,
      exclusionReasons: ["request excluded source:dblp"],
    });
  });

  it("keeps preset exclusions local before request-level union", () => {
    const config = createConfig();
    Object.assign(config.search, {
      presets: {
        narrow: {
          extends: ["general"],
          include: [],
          exclude: ["source:semantic"],
        },
        semantic: {
          extends: [],
          include: ["source:semantic"],
          exclude: [],
        },
      },
    });
    const providers = [provider({ id: "openalex" }), provider({ id: "semantic" })];

    const plan = resolveProviderSelection(config, "academic", providers, {
      presets: ["narrow", "semantic"],
    });
    expect(plan.runnableProviderIds).toEqual(["openalex", "semantic"]);
  });

  it("supports namespaced user tags, canonicalizes aliases, and excludes views from tags", () => {
    const config = createConfig();
    Object.assign(config.search, {
      classifications: {
        preferred: { sources: ["medline", "acm"] },
      },
    });
    const providers = [
      provider({ id: "pubmed", domains: ["biomedicine"], aliases: ["medline"] }),
      provider({ id: "acm", entryKind: "view", domains: ["computer-science"] }),
    ];

    const tagged = resolveProviderSelection(config, "academic", providers, {
      categories: ["tag:preferred"],
    });
    expect(tagged.runnableProviderIds).toEqual(["pubmed"]);
    expect(tagged.warnings).toContain(
      "Configured source is a view and was ignored by tag:preferred: acm",
    );

    const explicitView = resolveProviderSelection(config, "academic", providers, {
      sources: ["acm"],
    });
    expect(explicitView.runnableProviderIds).toEqual(["acm"]);
  });

  it("keeps explicit source-backed views and reports overlap with their backing source", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "crossref" }),
      provider({ id: "acm", entryKind: "view", domains: ["computer-science"] }),
    ];

    const plan = resolveProviderSelection(config, "academic", providers, {
      sources: ["crossref", "acm"],
    });
    expect(plan.runnableProviderIds).toEqual(["acm", "crossref"]);
    expect(plan.warnings).toEqual([
      "Selected view acm overlaps backing source crossref (example.crossref)",
    ]);
  });

  it("explains why a legacy manifest is absent from classification presets", () => {
    const config = createConfig();
    const legacy = provider({ id: "legacy" });
    delete legacy.manifest!.inventory;

    const plan = resolveProviderSelection(config, "academic", [legacy]);
    expect(plan.entries[0]).toMatchObject({
      id: "legacy",
      selected: false,
      exclusionReasons: [
        "provider has no inventory classification; select it by exact id or literal all",
      ],
    });
    expect(
      resolveProviderSelection(config, "academic", [legacy], { platform: "all" })
        .runnableProviderIds,
    ).toEqual(["legacy"]);
  });

  it("does not add general when an explicit positive selector is supplied", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "openalex" }),
      provider({ id: "pubmed", domains: ["biomedicine"] }),
    ];
    const plan = resolveProviderSelection(config, "academic", providers, {
      sources: ["pubmed"],
    });
    expect(plan.usedDefaults).toBe(false);
    expect(plan.runnableProviderIds).toEqual(["pubmed"]);
  });

  it("rejects cyclic user preset inheritance", () => {
    const config = createConfig();
    Object.assign(config.search, {
      presets: {
        first: { extends: ["second"], include: [], exclude: [] },
        second: { extends: ["first"], include: [], exclude: [] },
      },
    });
    expect(() =>
      resolveProviderSelection(config, "academic", [provider({ id: "openalex" })], {
        presets: ["first"],
      }),
    ).toThrow(/inheritance cycle/);
  });

  it("rejects a selector token shared by one canonical id and another provider alias", () => {
    const config = createConfig();
    const providers = [
      provider({ id: "alpha" }),
      provider({ id: "beta", aliases: ["alpha"] }),
    ];
    expect(() =>
      resolveProviderSelection(config, "academic", providers, { sources: ["alpha"] }),
    ).toThrow(/selector is ambiguous: alpha -> alpha, beta/);
  });
});
