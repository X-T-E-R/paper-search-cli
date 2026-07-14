import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  loadMaterialProviderRegistryManifest,
  materialRegistryMinRequiredVersion,
  parseMaterialProviderRegistryManifest,
} from "../../src/material/registry/load.js";

describe("material provider registry load", () => {
  it("accepts the generated material registry shape and preserves its provider subtype", () => {
    const manifest = parseMaterialProviderRegistryManifest(
      JSON.stringify({
        providers: [
          {
            id: "unpaywall",
            version: "1.0.0",
            kind: "artifact_resolver",
            downloadUrl: "https://example.test/releases/unpaywall.zip",
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            minCliVersion: "0.1.0",
          },
        ],
      }),
    );

    expect(manifest.providers[0]).toEqual({
      id: "unpaywall",
      version: "1.0.0",
      kind: "artifact_resolver",
      downloadUrl: "https://example.test/releases/unpaywall.zip",
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      minCliVersion: "0.1.0",
    });
  });

  it("loads the generated shape from an HTTP registry URL", async () => {
    const body = JSON.stringify({
      providers: [
        {
          id: "remote-extractor",
          version: "1.0.0",
          kind: "extractor",
          downloadUrl: "./remote-extractor.zip",
          sha256: "0".repeat(64),
          minCliVersion: "0.1.0",
        },
      ],
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const registry = await loadMaterialProviderRegistryManifest(
        `http://127.0.0.1:${port}/registry.json`,
      );
      expect(registry.kind).toBe("remote");
      expect(registry.manifest.providers[0]).toMatchObject({
        id: "remote-extractor",
        kind: "extractor",
        downloadUrl: "./remote-extractor.zip",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects generated entries with an unknown material subtype", () => {
    expect(() =>
      parseMaterialProviderRegistryManifest(
        JSON.stringify({
          providers: [
            {
              id: "wrong-kind",
              version: "1.0.0",
              kind: "search",
              downloadUrl: "./wrong-kind.zip",
            },
          ],
        }),
      ),
    ).toThrow(/kind must be one of/);
  });

  it("accepts minCliVersion and keeps minPluginVersion as a legacy alias field", () => {
    const manifest = parseMaterialProviderRegistryManifest(
      JSON.stringify({
        providers: [
          {
            id: "unpaywall",
            version: "1.0.0",
            archiveRef: "dist/unpaywall.zip",
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            minCliVersion: "0.2.0",
          },
          {
            id: "legacy-gate",
            version: "1.0.0",
            packagePath: "./legacy",
            minPluginVersion: "0.3.0",
          },
        ],
      }),
    );

    const unpaywall = manifest.providers[0]!;
    const legacy = manifest.providers[1]!;
    expect(unpaywall).toMatchObject({
      id: "unpaywall",
      minCliVersion: "0.2.0",
    });
    expect(materialRegistryMinRequiredVersion(unpaywall)).toBe("0.2.0");
    expect(legacy).toMatchObject({
      id: "legacy-gate",
      minPluginVersion: "0.3.0",
    });
    expect(materialRegistryMinRequiredVersion(legacy)).toBe("0.3.0");
  });

  it("prefers minCliVersion over minPluginVersion when both are present", () => {
    const manifest = parseMaterialProviderRegistryManifest(
      JSON.stringify({
        providers: [
          {
            id: "both-fields",
            version: "1.0.0",
            packagePath: "./pkg",
            minCliVersion: "1.0.0",
            minPluginVersion: "9.9.9",
          },
        ],
      }),
    );
    expect(materialRegistryMinRequiredVersion(manifest.providers[0]!)).toBe("1.0.0");
  });
});
