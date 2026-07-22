import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  stageMaterialProviderVerificationArtifacts,
} from "../../scripts/lib/material-provider-verification.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

describe("isolated material-provider verification staging", () => {
  it("builds providers before staging the artifacts required by target tests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-verification-"));
    temporaryRoots.push(root);
    const cliRepoRoot = path.join(root, "paper-search-cli");
    const providerRoot = path.join(root, "material-providers");
    const stagedSourcePath = path.join(root, "runtime", "transaction", "source");
    await mkdir(cliRepoRoot, { recursive: true });
    await mkdir(providerRoot, { recursive: true });
    await mkdir(stagedSourcePath, { recursive: true });
    await writeFile(path.join(providerRoot, "package.json"), "{}\n", "utf8");

    let buildCompleted = false;
    const result = await stageMaterialProviderVerificationArtifacts({
      cliRepoRoot,
      stagedSourcePath,
      env: { PAPER_SEARCH_MATERIAL_PROVIDERS_ROOT: providerRoot },
      buildDistributions: async (selectedRoot: string) => {
        expect(selectedRoot).toBe(providerRoot);
        const packagePath = path.join(selectedRoot, "dist", "direct-url-downloader");
        await mkdir(packagePath, { recursive: true });
        await writeFile(path.join(packagePath, "manifest.json"), '{"id":"direct-url-downloader"}\n', "utf8");
        await writeFile(path.join(packagePath, "provider.js"), "// built provider\n", "utf8");
        buildCompleted = true;
      },
    });

    expect(buildCompleted).toBe(true);
    expect(result.stagedDistributionRoot).toBe(
      path.join(root, "runtime", "transaction", "material-providers", "dist"),
    );
    await expect(readFile(
      path.join(result.stagedDistributionRoot, "direct-url-downloader", "manifest.json"),
      "utf8",
    )).resolves.toContain("direct-url-downloader");
    await expect(readFile(
      path.join(result.stagedDistributionRoot, "direct-url-downloader", "provider.js"),
      "utf8",
    )).resolves.toContain("built provider");
  });

  it("fails before target tests when the provider build omits a required distribution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-verification-missing-"));
    temporaryRoots.push(root);
    const cliRepoRoot = path.join(root, "paper-search-cli");
    const providerRoot = path.join(root, "material-providers");
    const stagedSourcePath = path.join(root, "runtime", "transaction", "source");
    await mkdir(cliRepoRoot, { recursive: true });
    await mkdir(providerRoot, { recursive: true });
    await mkdir(stagedSourcePath, { recursive: true });
    await writeFile(path.join(providerRoot, "package.json"), "{}\n", "utf8");

    await expect(stageMaterialProviderVerificationArtifacts({
      cliRepoRoot,
      stagedSourcePath,
      env: { PAPER_SEARCH_MATERIAL_PROVIDERS_ROOT: providerRoot },
      buildDistributions: async () => {
        await mkdir(path.join(providerRoot, "dist"), { recursive: true });
      },
    })).rejects.toThrow("Built direct-url-downloader manifest is missing");
  });
});
