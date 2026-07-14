import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import {
  listProviderPackageDirectories,
  resolveProviderPackageDirectory,
} from "../providers/paths.js";
import { loadMaterialProviderPackage, type LoadedMaterialProviderPackage } from "./package/load.js";
import { parseMaterialResolverResult } from "./resolverResult.js";
import { createMaterialRuntimeContext } from "./runtime/createContext.js";
import { resolveMaterialProviderCacheRoot } from "./cache.js";
import { invokeMaterialProviderFactoryInNode } from "./runtime/invokeNodeFactory.js";
import type {
  MaterialIdentifierInput,
  MaterialResolverCandidateLocation,
  MaterialResolverResult,
} from "./types.js";
import type { ArtifactAttempt } from "./records.js";

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

export class AcquireResolverError extends Error {
  readonly failureKind: "no_resolver" | "no_candidates" | "resolver_error";

  constructor(
    message: string,
    failureKind: "no_resolver" | "no_candidates" | "resolver_error",
    readonly attempts: ArtifactAttempt[] = [],
  ) {
    super(message);
    this.name = "AcquireResolverError";
    this.failureKind = failureKind;
  }
}

export interface ResolverProviderSummary {
  id: string;
  name: string;
  version: string;
  packagePath: string;
}

function fail(message: string): never {
  throw new AcquireResolverError(message, "resolver_error");
}

function normalizeResolverProviderId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) fail("--resolver must be a non-empty provider id");
  if (!PROVIDER_ID_RE.test(trimmed)) {
    fail("--resolver must be a material provider id, not a path");
  }
  return trimmed;
}

async function providerPackageDirectories(installDir: string): Promise<string[]> {
  return (await listProviderPackageDirectories(installDir, "material"))
    .sort((left, right) => left.localeCompare(right));
}

function providerSupportsResolver(providerPackage: LoadedMaterialProviderPackage): boolean {
  const caps = providerPackage.manifest.capabilities;
  return (
    providerPackage.manifest.kind === "artifact_resolver" &&
    caps.inputs.includes("identifier") &&
    caps.outputs.includes("locations") &&
    (caps.identifierSchemes?.includes("doi") ?? false)
  );
}

function resolverSummary(providerPackage: LoadedMaterialProviderPackage): ResolverProviderSummary {
  return {
    id: providerPackage.manifest.id,
    name: providerPackage.manifest.name,
    version: providerPackage.manifest.version,
    packagePath: providerPackage.packagePath,
  };
}

export async function selectResolverProvider(options: {
  installDir: string;
  resolverProviderId?: string;
}): Promise<LoadedMaterialProviderPackage> {
  const installDir = path.resolve(options.installDir);
  const resolverProviderId = normalizeResolverProviderId(options.resolverProviderId);
  const packageDirs = resolverProviderId
    ? [await resolveProviderPackageDirectory(installDir, "material", resolverProviderId)]
    : await providerPackageDirectories(installDir);

  const loadErrors: string[] = [];
  for (const packageDir of packageDirs) {
    try {
      const providerPackage = await loadMaterialProviderPackage(packageDir);
      if (resolverProviderId && providerPackage.manifest.id !== resolverProviderId) {
        fail(
          `Selected resolver id ${resolverProviderId} does not match manifest id ${providerPackage.manifest.id}`,
        );
      }
      if (providerSupportsResolver(providerPackage)) {
        return providerPackage;
      }
      loadErrors.push(`${providerPackage.manifest.id}: does not support DOI identifier -> locations resolution`);
    } catch (error) {
      loadErrors.push(`${path.basename(packageDir)}: ${formatError(error)}`);
    }
  }

  throw new AcquireResolverError(
    [
      resolverProviderId
        ? `Material artifact resolver provider not usable: ${resolverProviderId}`
        : `No usable material artifact_resolver provider found in ${installDir}`,
      ...loadErrors.map((entry) => `- ${entry}`),
    ].join("\n"),
    "no_resolver",
  );
}

export async function planResolverProvider(options: {
  installDir: string;
  resolverProviderId?: string;
}): Promise<ResolverProviderSummary> {
  const providerPackage = await selectResolverProvider(options);
  return resolverSummary(providerPackage);
}

function resolverAttempt(options: {
  providerId: string;
  ok: boolean;
  message: string;
  source?: string;
  at: string;
  status?: number;
}): ArtifactAttempt {
  return {
    tier: "artifact-resolver",
    source: options.source,
    providerId: options.providerId,
    ok: options.ok,
    ...(options.status !== undefined ? { status: options.status } : {}),
    message: options.message,
    at: options.at,
  };
}

export interface ResolvedAcquireCandidates {
  resolver: ResolverProviderSummary;
  identifier: MaterialIdentifierInput;
  candidates: MaterialResolverCandidateLocation[];
  resolverResult: MaterialResolverResult;
  attempts: ArtifactAttempt[];
}

export async function resolveAcquireCandidates(options: {
  config: ResolvedConfig;
  identifier: MaterialIdentifierInput;
  policy: string;
  resolverProviderId?: string;
  attachTo?: string | null;
}): Promise<ResolvedAcquireCandidates> {
  const createdAt = new Date().toISOString();
  const providerPackage = await selectResolverProvider({
    installDir: options.config.providers.installDir,
    resolverProviderId: options.resolverProviderId,
  });
  const resolver = resolverSummary(providerPackage);
  const runtimeContext = createMaterialRuntimeContext({
    manifest: providerPackage.manifest,
    providerConfig: (options.config.platform[resolver.id] ?? {}) as Record<string, unknown>,
    policy: {
      name: options.policy,
      capability: "acquire",
      attachTo: options.attachTo ?? null,
    },
    cacheRoot: resolveMaterialProviderCacheRoot(options.config),
    workspaceRoot: options.config.workspace.root,
  });
  const loadedProvider = await invokeMaterialProviderFactoryInNode(
    providerPackage.bundleCode,
    providerPackage.manifest,
    runtimeContext,
  );
  const resolveMethod = loadedProvider.provider.resolve;
  if (!resolveMethod) {
    throw new AcquireResolverError(
      `Material provider ${resolver.id} does not implement resolve()`,
      "resolver_error",
      [
        resolverAttempt({
          providerId: resolver.id,
          ok: false,
          message: "Provider bundle does not expose resolve()",
          at: createdAt,
        }),
      ],
    );
  }

  let resolverResult: MaterialResolverResult;
  try {
    resolverResult = parseMaterialResolverResult(
      await resolveMethod({
        identifier: options.identifier,
        policy: options.policy,
        ...(options.attachTo ? { attachTo: options.attachTo } : {}),
      }),
    );
  } catch (error) {
    const message = formatError(error);
    throw new AcquireResolverError(
      `Artifact resolver failed (${resolver.id}): ${message}`,
      "resolver_error",
      [
        resolverAttempt({
          providerId: resolver.id,
          ok: false,
          message,
          source: options.identifier.value,
          at: createdAt,
        }),
      ],
    );
  }

  const attempts = [
    resolverAttempt({
      providerId: resolver.id,
      ok: true,
      message:
        resolverResult.candidates.length > 0
          ? `Resolved ${resolverResult.candidates.length} candidate location(s)`
          : "Resolver returned no candidate locations",
      source: resolverResult.provenance.source ?? resolver.id,
      at: createdAt,
    }),
  ];

  if (resolverResult.candidates.length === 0) {
    throw new AcquireResolverError(
      `No artifact locations resolved for DOI ${options.identifier.value}`,
      "no_candidates",
      attempts,
    );
  }

  return {
    resolver,
    identifier: resolverResult.identifier,
    candidates: resolverResult.candidates,
    resolverResult,
    attempts,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
