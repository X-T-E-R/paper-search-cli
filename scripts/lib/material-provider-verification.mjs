import { cp, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const REQUIRED_SELF_UPDATE_PROVIDER_IDS = ["direct-url-downloader"];

async function assertFile(filePath, label) {
  const entry = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing: ${filePath}`);
    }
    throw error;
  });
  if (!entry.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

export function resolveMaterialProvidersRoot(cliRepoRoot, env = process.env) {
  const configured = env.PAPER_SEARCH_MATERIAL_PROVIDERS_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(cliRepoRoot, "..", "material-providers");
}

/**
 * Build the sibling provider distribution and stage its immutable build output
 * beside the isolated CLI source, matching the layout used by integration tests.
 */
export async function stageMaterialProviderVerificationArtifacts(options) {
  const providerRoot = resolveMaterialProvidersRoot(options.cliRepoRoot, options.env);
  await assertFile(path.join(providerRoot, "package.json"), "Material provider package manifest");
  await options.buildDistributions(providerRoot);

  const distributionRoot = path.join(providerRoot, "dist");
  for (const providerId of REQUIRED_SELF_UPDATE_PROVIDER_IDS) {
    await assertFile(
      path.join(distributionRoot, providerId, "manifest.json"),
      `Built ${providerId} manifest`,
    );
    await assertFile(
      path.join(distributionRoot, providerId, "provider.js"),
      `Built ${providerId} entrypoint`,
    );
  }

  const stagedProviderRoot = path.resolve(options.stagedSourcePath, "..", "material-providers");
  const stagedDistributionRoot = path.join(stagedProviderRoot, "dist");
  await rm(stagedProviderRoot, { recursive: true, force: true });
  await mkdir(stagedProviderRoot, { recursive: true });
  await cp(distributionRoot, stagedDistributionRoot, { recursive: true });
  return { providerRoot, distributionRoot, stagedDistributionRoot };
}
