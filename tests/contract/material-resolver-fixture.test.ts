import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMaterialProviderManifest } from "../../src/material/manifest.js";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import { createMaterialRuntimeContext } from "../../src/material/runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "../../src/material/runtime/invokeNodeFactory.js";
import { parseMaterialResolverResult } from "../../src/material/resolverResult.js";

const fixtureRoot = path.resolve(
  "tests",
  "fixtures",
  "material-resolvers",
  "fixture-artifact-resolver",
);

describe("fixture artifact resolver package", () => {
  it("loads a valid artifact_resolver manifest", async () => {
    const raw = await readFile(path.join(fixtureRoot, "manifest.json"), "utf8");
    const manifest = parseMaterialProviderManifest(raw);
    expect(manifest.kind).toBe("artifact_resolver");
    expect(manifest.capabilities.identifierSchemes).toEqual(["doi"]);
  });

  it("returns ordered candidates in multi mode", async () => {
    const loaded = await loadMaterialProviderPackage(fixtureRoot);
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: { mode: "multi" },
      policy: { name: "contract", capability: "acquire" },
      cacheRoot: path.join(fixtureRoot, ".cache"),
      workspaceRoot: path.join(fixtureRoot, ".workspace"),
    });
    const runtime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );
    expect(runtime.provider.resolve).toBeDefined();
    const result = parseMaterialResolverResult(
      await runtime.provider.resolve!({
        identifier: { scheme: "doi", value: "10.1234/contract-probe" },
      }),
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.url).toContain("primary.pdf");
    expect(result.provenance.providerId).toBe("fixture-artifact-resolver");
  });
});
