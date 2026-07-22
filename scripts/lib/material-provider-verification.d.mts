export interface MaterialProviderVerificationOptions {
  cliRepoRoot: string;
  stagedSourcePath: string;
  env?: Record<string, string | undefined>;
  buildDistributions(providerRoot: string): Promise<void>;
}

export interface MaterialProviderVerificationResult {
  providerRoot: string;
  distributionRoot: string;
  stagedDistributionRoot: string;
}

export function resolveMaterialProvidersRoot(
  cliRepoRoot: string,
  env?: Record<string, string | undefined>,
): string;

export function stageMaterialProviderVerificationArtifacts(
  options: MaterialProviderVerificationOptions,
): Promise<MaterialProviderVerificationResult>;
