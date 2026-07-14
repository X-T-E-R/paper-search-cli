import { describe, expect, it } from "vitest";
import {
  MaterialManifestValidationError,
  parseMaterialProviderManifest,
} from "../../src/material/manifest.js";

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "mineru-extractor",
    name: "MinerU Extractor",
    version: "0.1.0",
    kind: "extractor",
    entry: "provider.js",
    capabilities: {
      inputs: ["url", "local_file", "artifact"],
      inputTypes: ["pdf", "html"],
      outputs: ["markdown", "json", "assets"],
      network: true,
    },
    configSchema: {
      token: { type: "secret", env: ["MINERU_TOKEN"], required: true },
      apiBase: { type: "string", default: "https://mineru.net" },
    },
    permissions: {
      network: ["https://mineru.net/*"],
      localRead: true,
      localWrite: "cache",
    },
    rateLimit: { requestsPerMinute: 30 },
    ...overrides,
  });
}

describe("parseMaterialProviderManifest", () => {
  it("accepts a valid networked extractor manifest", () => {
    const parsed = parseMaterialProviderManifest(manifest());
    expect(parsed.id).toBe("mineru-extractor");
    expect(parsed.kind).toBe("extractor");
    expect(parsed.capabilities.outputs).toContain("markdown");
    expect(parsed.permissions.network).toEqual(["https://mineru.net/*"]);
    expect(parsed.configSchema?.token?.type).toBe("secret");
  });

  it("accepts a no-network local converter without network permissions", () => {
    const parsed = parseMaterialProviderManifest(
      manifest({
        id: "local-pdf-text",
        kind: "converter",
        capabilities: { inputs: ["local_file"], outputs: ["markdown"], network: false },
        permissions: { localRead: true, localWrite: "cache" },
      }),
    );
    expect(parsed.capabilities.network).toBe(false);
    expect(parsed.permissions.network).toBeUndefined();
  });

  it("rejects an invalid provider kind", () => {
    expect(() => parseMaterialProviderManifest(manifest({ kind: "search" }))).toThrow(
      MaterialManifestValidationError,
    );
  });

  it("rejects an invalid id", () => {
    expect(() => parseMaterialProviderManifest(manifest({ id: "Bad Id" }))).toThrow(
      MaterialManifestValidationError,
    );
  });

  it("requires network permissions when capabilities.network is true", () => {
    expect(() =>
      parseMaterialProviderManifest(
        manifest({
          capabilities: { inputs: ["url"], outputs: ["markdown"], network: true },
          permissions: { localRead: true },
        }),
      ),
    ).toThrow(/permissions.network must list allowed URL patterns/);
  });

  it("rejects an entry that escapes the package", () => {
    expect(() => parseMaterialProviderManifest(manifest({ entry: "../evil.js" }))).toThrow(
      MaterialManifestValidationError,
    );
    expect(() => parseMaterialProviderManifest(manifest({ entry: "/abs/evil.js" }))).toThrow(
      MaterialManifestValidationError,
    );
  });

  it("rejects unknown input/output kinds", () => {
    expect(() =>
      parseMaterialProviderManifest(
        manifest({ capabilities: { inputs: ["stream"], outputs: ["markdown"], network: false } }),
      ),
    ).toThrow(/capabilities.inputs has invalid entry/);
  });

  it("rejects a non-semver version", () => {
    expect(() => parseMaterialProviderManifest(manifest({ version: "v1" }))).toThrow(
      MaterialManifestValidationError,
    );
  });
});

function resolverManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "unpaywall",
    name: "Unpaywall OA Resolver",
    version: "0.1.0",
    kind: "artifact_resolver",
    entry: "provider.js",
    capabilities: {
      inputs: ["identifier"],
      identifierSchemes: ["doi"],
      outputs: ["locations"],
      network: true,
    },
    configSchema: {
      email: { type: "string", env: ["UNPAYWALL_EMAIL"], required: true },
    },
    permissions: {
      network: ["https://api.unpaywall.org/*"],
    },
    rateLimit: { requestsPerMinute: 60 },
    ...overrides,
  });
}

describe("parseMaterialProviderManifest for artifact_resolver", () => {
  it("accepts a valid DOI resolver manifest", () => {
    const parsed = parseMaterialProviderManifest(resolverManifest());
    expect(parsed.kind).toBe("artifact_resolver");
    expect(parsed.capabilities.inputs).toContain("identifier");
    expect(parsed.capabilities.identifierSchemes).toEqual(["doi"]);
    expect(parsed.capabilities.outputs).toContain("locations");
  });

  it("requires identifier inputs on resolver manifests", () => {
    expect(() =>
      parseMaterialProviderManifest(
        resolverManifest({
          capabilities: { inputs: ["url"], outputs: ["locations"], network: true },
        }),
      ),
    ).toThrow(/artifact_resolver manifests must accept identifier inputs/);
  });

  it("requires locations outputs on resolver manifests", () => {
    expect(() =>
      parseMaterialProviderManifest(
        resolverManifest({
          capabilities: {
            inputs: ["identifier"],
            identifierSchemes: ["doi"],
            outputs: ["json"],
            network: true,
          },
        }),
      ),
    ).toThrow(/artifact_resolver manifests must declare locations outputs/);
  });

  it("requires identifierSchemes when inputs include identifier", () => {
    expect(() =>
      parseMaterialProviderManifest(
        resolverManifest({
          capabilities: { inputs: ["identifier"], outputs: ["locations"], network: true },
        }),
      ),
    ).toThrow(/capabilities.identifierSchemes must list supported schemes/);
  });

  it("rejects unknown identifier schemes", () => {
    expect(() =>
      parseMaterialProviderManifest(
        resolverManifest({
          capabilities: {
            inputs: ["identifier"],
            identifierSchemes: ["isbn"],
            outputs: ["locations"],
            network: true,
          },
        }),
      ),
    ).toThrow(/capabilities.identifierSchemes has invalid entry: isbn/);
  });

  it("rejects identifierSchemes without an identifier input", () => {
    expect(() =>
      parseMaterialProviderManifest(
        manifest({
          capabilities: {
            inputs: ["url"],
            identifierSchemes: ["doi"],
            outputs: ["markdown"],
            network: true,
          },
        }),
      ),
    ).toThrow(/capabilities.identifierSchemes requires inputs to include identifier/);
  });
});
