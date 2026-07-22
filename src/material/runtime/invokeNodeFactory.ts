import vm from "node:vm";
import type { LoadedMaterialProviderPackage } from "../package/load.js";
import type { MaterialProviderManifest } from "../types.js";
import type { MaterialRuntimeContext } from "./createContext.js";
import { sanitizeUrlsForPersistenceInText } from "../../runtime/sanitizeUrl.js";

export interface MaterialProviderInspection {
  methods: string[];
}

export type MaterialNodeProvider = Record<string, (...args: unknown[]) => Promise<unknown>>;

export interface LoadedMaterialNodeProvider {
  inspection: MaterialProviderInspection;
  provider: MaterialNodeProvider;
}

function sanitizeResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error) return sanitizeUrlsForPersistenceInText(error.message);
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return sanitizeUrlsForPersistenceInText(error.message);
  }
  return sanitizeUrlsForPersistenceInText(String(error));
}

function createContext(runtimeContext: MaterialRuntimeContext): vm.Context {
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
    runtimeContext,
  });
}

function buildInitSource(bundleCode: string): string {
  return `(() => {
${bundleCode}
const exp =
  typeof __material_provider_exports !== "undefined"
    ? __material_provider_exports
    : typeof globalThis !== "undefined"
      ? globalThis.__material_provider_exports
      : undefined;
if (!exp || typeof exp.createProvider !== "function") {
  throw new Error("Missing __material_provider_exports.createProvider");
}
globalThis.__paper_search_material_provider = exp.createProvider(runtimeContext);
if (
  !globalThis.__paper_search_material_provider ||
  typeof globalThis.__paper_search_material_provider !== "object"
) {
  throw new Error("createProvider must return an object");
}
return {
  methods: Object.keys(globalThis.__paper_search_material_provider)
    .filter((key) => typeof globalThis.__paper_search_material_provider[key] === "function")
};
})()`;
}

function wrapProviderMethod(
  manifest: MaterialProviderManifest,
  providerObject: Record<string, unknown>,
  method: string,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    const candidate = providerObject[method];
    if (typeof candidate !== "function") {
      throw new Error(`Provider ${manifest.id} does not implement ${method}()`);
    }
    try {
      return sanitizeResult(await Reflect.apply(candidate, providerObject, args));
    } catch (error) {
      throw new Error(
        `${method}() failed (${manifest.id}): ${providerErrorMessage(error)}`,
      );
    }
  };
}

export async function invokeMaterialProviderFactoryInNode(
  bundleCode: string,
  manifest: MaterialProviderManifest,
  runtimeContext: MaterialRuntimeContext,
): Promise<LoadedMaterialNodeProvider> {
  const context = createContext(runtimeContext);
  context.globalThis = context;
  const script = new vm.Script(buildInitSource(bundleCode), {
    filename: `material-provider-${manifest.id}.js`,
  });

  let inspection: MaterialProviderInspection;
  try {
    inspection = script.runInContext(context) as MaterialProviderInspection;
  } catch (error) {
    const message = providerErrorMessage(error);
    if (message.includes("Missing __material_provider_exports.createProvider")) {
      throw new Error(`Missing __material_provider_exports.createProvider in bundle: ${manifest.id}`);
    }
    throw new Error(`createProvider() failed (${manifest.id}): ${message}`);
  }

  const providerObject = context.__paper_search_material_provider as Record<string, unknown>;
  const provider: MaterialNodeProvider = {};
  for (const method of inspection.methods) {
    provider[method] = wrapProviderMethod(manifest, providerObject, method);
  }

  return {
    inspection,
    provider,
  };
}

export async function inspectMaterialProviderPackageInNode(
  providerPackage: LoadedMaterialProviderPackage,
  runtimeContext: MaterialRuntimeContext,
): Promise<MaterialProviderInspection> {
  const loaded = await invokeMaterialProviderFactoryInNode(
    providerPackage.bundleCode,
    providerPackage.manifest,
    runtimeContext,
  );
  return loaded.inspection;
}
