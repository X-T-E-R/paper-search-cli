import path from "node:path";
import { describe, expect, it } from "vitest";
import { MaterialManifestValidationError } from "../../src/material/manifest.js";
import {
  loadMaterialProviderPackage,
  MaterialProviderPackageLoadError,
} from "../../src/material/package/load.js";

const packagesRoot = path.resolve("tests", "fixtures", "material-provider-packages");

describe("material provider package loading", () => {
  it("loads a fixture package from disk and exposes inspectable package content", async () => {
    const fixturePackagePath = path.join(packagesRoot, "fixture-extractor");
    const loaded = await loadMaterialProviderPackage(fixturePackagePath);

    expect(loaded.packagePath).toBe(fixturePackagePath);
    expect(loaded.manifestPath).toBe(path.join(fixturePackagePath, "manifest.json"));
    expect(loaded.entrypointPath).toBe(path.join(fixturePackagePath, "provider.js"));
    expect(loaded.manifest).toMatchObject({
      id: "fixture-extractor",
      kind: "extractor",
      entry: "provider.js",
      capabilities: {
        inputs: ["url", "local_file", "artifact"],
        outputs: ["markdown", "json"],
        network: false,
      },
    });
    expect(loaded.bundleCode).toContain("__material_provider_exports");
  });

  it("rejects an invalid material manifest through the material manifest parser", async () => {
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "invalid-manifest")),
    ).rejects.toThrow(MaterialManifestValidationError);
  });

  it("rejects a manifest that omits entry through the material manifest parser", async () => {
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "missing-entry-field")),
    ).rejects.toThrow(MaterialManifestValidationError);
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "missing-entry-field")),
    ).rejects.toThrow("manifest.entry must be a relative file path inside the package");
  });

  it("rejects a manifest entry that escapes the package root through the material manifest parser", async () => {
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "unsafe-entrypoint")),
    ).rejects.toThrow(MaterialManifestValidationError);
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "unsafe-entrypoint")),
    ).rejects.toThrow("manifest.entry must be a relative file path inside the package");
  });

  it("rejects a package whose declared entrypoint is missing", async () => {
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "missing-entrypoint")),
    ).rejects.toThrow(MaterialProviderPackageLoadError);
  });

  it("rejects a package whose declared entrypoint is a directory", async () => {
    await expect(
      loadMaterialProviderPackage(path.join(packagesRoot, "directory-entrypoint")),
    ).rejects.toThrow(/entrypoint must be a file/);
  });
});
