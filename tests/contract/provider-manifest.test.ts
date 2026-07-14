import { describe, expect, it } from "vitest";
import { ManifestValidationError, parseProviderManifest } from "../../src/providers/manifest/validate.js";

describe("parseProviderManifest", () => {
  it("accepts a valid academic provider manifest", () => {
    const manifest = parseProviderManifest(
      JSON.stringify({
        id: "crossref",
        name: "Crossref",
        version: "1.0.0",
        sourceType: "academic",
        permissions: {
          urls: ["https://api.crossref.org/*"],
        },
        configSchema: {
          enabled: { type: "boolean", default: true },
          apiKey: { type: "string", required: true, secret: true },
        },
      }),
    );

    expect(manifest.id).toBe("crossref");
    expect(manifest.permissions.urls).toEqual(["https://api.crossref.org/*"]);
    expect(manifest.configSchema?.apiKey).toMatchObject({ required: true, secret: true });
  });

  it("rejects invalid provider IDs", () => {
    expect(() =>
      parseProviderManifest(
        JSON.stringify({
          id: "Bad Id",
          name: "Broken",
          version: "1.0.0",
          sourceType: "academic",
          permissions: {
            urls: ["https://example.com/*"],
          },
        }),
      ),
    ).toThrow(ManifestValidationError);
  });
});
