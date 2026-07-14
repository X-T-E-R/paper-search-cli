import vm from "node:vm";
import type { LoadedProviderPackage } from "../package/load.js";
import type {
  PluggableProviderImpl,
  ProviderAPI,
  ProviderManifest,
  SearchOptions,
  SearchResult,
  PatentDetailResult,
  CitationPageRequest,
  CitationRelationPage,
} from "../sdk/types.js";

export interface ProviderInspection {
  hasSearch: boolean;
  hasGetDetail: boolean;
  hasGetCitationPage: boolean;
}

export interface LoadedNodeProvider {
  inspection: ProviderInspection;
  provider: PluggableProviderImpl;
}

function sanitizeResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createContext(api: ProviderAPI): vm.Context {
  return vm.createContext({
    globalThis: undefined,
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Promise,
    setTimeout,
    clearTimeout,
    AbortController,
    api,
  });
}

function buildInitSource(bundleCode: string): string {
  return `(() => {
${bundleCode}
const exp =
  typeof __zrs_exports !== "undefined"
    ? __zrs_exports
    : typeof globalThis !== "undefined"
      ? globalThis.__zrs_exports
      : undefined;
if (!exp || typeof exp.createProvider !== "function") {
  throw new Error("Missing __zrs_exports.createProvider");
}
globalThis.__paper_search_provider = exp.createProvider(api);
return {
  hasSearch:
    !!globalThis.__paper_search_provider &&
    typeof globalThis.__paper_search_provider.search === "function",
  hasGetDetail:
    !!globalThis.__paper_search_provider &&
    typeof globalThis.__paper_search_provider.getDetail === "function",
  hasGetCitationPage:
    !!globalThis.__paper_search_provider &&
    typeof globalThis.__paper_search_provider.getCitationPage === "function"
};
})()`;
}

function wrapProviderMethod<Args extends unknown[], Result>(
  manifest: ProviderManifest,
  providerObject: Record<string, unknown>,
  method: "search" | "getDetail" | "getCitationPage",
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const candidate = providerObject[method];
    if (typeof candidate !== "function") {
      throw new Error(`Provider ${manifest.id} does not implement ${method}()`);
    }
    try {
      const result = await Reflect.apply(candidate, providerObject, args);
      return sanitizeResult(result as Result);
    } catch (error) {
      throw new Error(
        `${method}() failed (${manifest.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

export async function invokeProviderFactoryInNode(
  bundleCode: string,
  manifest: ProviderManifest,
  api: ProviderAPI,
): Promise<LoadedNodeProvider> {
  const context = createContext(api);
  context.globalThis = context;
  const script = new vm.Script(buildInitSource(bundleCode), {
    filename: `provider-${manifest.id}.js`,
  });
  let inspection: ProviderInspection;
  try {
    inspection = script.runInContext(context) as ProviderInspection;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Missing __zrs_exports.createProvider")) {
      throw new Error(`Missing __zrs_exports.createProvider in bundle: ${manifest.id}`);
    }
    throw new Error(`createProvider() failed (${manifest.id}): ${message}`);
  }

  if (!inspection.hasSearch) {
    throw new Error(`createProvider must return { search() } (${manifest.id})`);
  }

  const providerObject = context.__paper_search_provider as Record<string, unknown>;
  const provider: PluggableProviderImpl = {
    async search(query: string, options?: SearchOptions): Promise<SearchResult> {
      return wrapProviderMethod<[string, SearchOptions | undefined], SearchResult>(
        manifest,
        providerObject,
        "search",
      )(query, options);
    },
  };

  if (inspection.hasGetDetail) {
    provider.getDetail = async (
      sourceId: string,
      options?: Record<string, unknown>,
    ): Promise<PatentDetailResult> => {
      return wrapProviderMethod<[string, Record<string, unknown> | undefined], PatentDetailResult>(
        manifest,
        providerObject,
        "getDetail",
      )(sourceId, options);
    };
  }

  if (inspection.hasGetCitationPage) {
    provider.getCitationPage = async (
      request: CitationPageRequest,
    ): Promise<CitationRelationPage> => {
      return wrapProviderMethod<[CitationPageRequest], CitationRelationPage>(
        manifest,
        providerObject,
        "getCitationPage",
      )(request);
    };
  }

  return {
    inspection,
    provider,
  };
}

export async function inspectProviderPackageInNode(
  providerPackage: LoadedProviderPackage,
  api: ProviderAPI,
): Promise<ProviderInspection> {
  const loaded = await invokeProviderFactoryInNode(
    providerPackage.bundleCode,
    providerPackage.manifest,
    api,
  );
  return loaded.inspection;
}
