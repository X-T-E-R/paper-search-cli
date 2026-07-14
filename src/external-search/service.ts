import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ResolvedConfig } from "../config/schema.js";
import { resolveConfigRoot } from "../config/paths.js";
import { failEnvelope, okEnvelope, type ResultEnvelope } from "../surface/resultEnvelope.js";
import { loadExternalSearchConfig, type LoadedExternalSearchConfig } from "./config.js";
import { ExternalSearchError, externalSearchError } from "./errors.js";
import { runBoundedProcess } from "./process.js";
import { parseExternalSearchResponse } from "./protocol.js";
import {
  EXTERNAL_SEARCH_PROTOCOL,
  EXTERNAL_SEARCH_VERSION,
  ExternalSearchSearchRequestSchema,
  type ExternalSearchProbeRequest,
  type ExternalSearchProbeResponse,
  type ExternalSearchRequest,
  type ExternalSearchSearchRequest,
  type ExternalSearchSearchResponse,
  type ExternalWebSearchRequest,
} from "./types.js";

export interface ExternalSearchRunOptions {
  signal?: AbortSignal;
  configRoot?: string;
  env?: NodeJS.ProcessEnv;
  adapterHostPath?: string;
}

function resolveAdapterHostPath(): string {
  return fileURLToPath(new URL("./adapter-host.mjs", import.meta.url));
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ");
}

function createProbeRequest(): ExternalSearchProbeRequest {
  return {
    protocol: EXTERNAL_SEARCH_PROTOCOL,
    version: EXTERNAL_SEARCH_VERSION,
    requestId: randomUUID(),
    operation: "probe",
  };
}

function createSearchRequest(config: ResolvedConfig, input: ExternalWebSearchRequest): ExternalSearchSearchRequest {
  return ExternalSearchSearchRequestSchema.parse({
    protocol: EXTERNAL_SEARCH_PROTOCOL,
    version: EXTERNAL_SEARCH_VERSION,
    requestId: randomUUID(),
    operation: "search",
    query: normalizeQuery(input.query),
    mode: input.mode ?? "auto",
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.freshness ? { freshness: input.freshness } : {}),
    maxResults: input.maxResults ?? config.defaults.maxResults,
  });
}

async function invoke(
  external: LoadedExternalSearchConfig,
  request: ExternalSearchRequest,
  options: ExternalSearchRunOptions,
): Promise<ExternalSearchProbeResponse | ExternalSearchSearchResponse> {
  const custom = external.adapter !== "native";
  const executable = custom ? process.execPath : external.process.executable;
  const args = custom
    ? [options.adapterHostPath ?? resolveAdapterHostPath()]
    : external.process.args;
  const stdin = custom
    ? JSON.stringify({
        adapterName: external.adapter,
        adapterPath: external.adapterPath,
        request,
        deadline: Date.now() + external.timeoutMs,
        process: external.process,
      })
    : JSON.stringify(request);
  const result = await runBoundedProcess({
    executable,
    args,
    cwd: external.process.workingDirectory,
    stdin,
    timeoutMs: external.timeoutMs,
    signal: options.signal,
  });
  return parseExternalSearchResponse(result.stdout, request) as ExternalSearchProbeResponse | ExternalSearchSearchResponse;
}

async function requireExternalConfig(options: ExternalSearchRunOptions): Promise<LoadedExternalSearchConfig> {
  const loaded = await loadExternalSearchConfig({ configRoot: options.configRoot, env: options.env });
  if (!loaded) {
    throw new ExternalSearchError(
      "external_search_disabled",
      "External web search is disabled. Configure the user-level external-search.toml to enable it.",
    );
  }
  return loaded;
}

export async function probeExternalSearch(
  options: ExternalSearchRunOptions = {},
): Promise<ExternalSearchProbeResponse> {
  const response = await invoke(await requireExternalConfig(options), createProbeRequest(), options);
  return response as ExternalSearchProbeResponse;
}

export async function runExternalWebSearch(
  config: ResolvedConfig,
  input: ExternalWebSearchRequest,
  options: ExternalSearchRunOptions = {},
): Promise<ExternalSearchSearchResponse> {
  const request = createSearchRequest(config, input);
  const response = await invoke(await requireExternalConfig(options), request, options);
  return response as ExternalSearchSearchResponse;
}

export async function runExternalWebSearchEnvelope(
  config: ResolvedConfig,
  input: ExternalWebSearchRequest,
  options: ExternalSearchRunOptions = {},
): Promise<ResultEnvelope> {
  try {
    const response = await runExternalWebSearch(config, input, options);
    if (!response.ok) {
      return failEnvelope({
        capability: "discover",
        tool: "web_search",
        errors: [response.error.message],
        warnings: response.warnings,
        diagnostics: { reason: response.error.code, retryable: response.error.retryable },
        provenance: response.provenance ? { externalSearch: response.provenance } : undefined,
      });
    }
    const providerIds = [...new Set(response.provenance.providerAttempts.map((attempt) => attempt.provider))];
    const configPath = path.join(
      path.resolve(options.configRoot ?? resolveConfigRoot(options.env ?? process.env)),
      "external-search.toml",
    );
    return okEnvelope({
      capability: "discover",
      tool: "web_search",
      data: response.data,
      warnings: response.warnings,
      diagnostics: {
        sourceCounts: Object.fromEntries(response.provenance.providerAttempts.map((attempt) => [attempt.provider, attempt.resultCount])),
        status: response.status,
      },
      provenance: {
        providerIds,
        configPaths: [configPath],
        externalSearch: response.provenance,
        semanticVerification: false,
      },
    });
  } catch (error) {
    const external = externalSearchError(error);
    return failEnvelope({
      capability: "discover",
      tool: "web_search",
      errors: [external.message],
      diagnostics: { reason: external.code, retryable: external.retryable, ...external.details },
    });
  }
}
