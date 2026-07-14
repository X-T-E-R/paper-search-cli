import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProviderRoot = path.resolve(scriptDir, "..", "..", "resource-search-providers");
const defaultMaterialProviderPackage = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "mineru-extractor",
);
const defaultUnpaywallProviderPackage = path.resolve(
  scriptDir,
  "..",
  "..",
  "material-providers",
  "dist",
  "unpaywall",
);
const defaultCases = ["crossref-live", "arxiv-live"];

function getArg(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }
  return process.argv[index + 1];
}

function parseTruthy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickCases() {
  const argCase = getArg("--case");
  const envCases = process.env.PAPER_SEARCH_SMOKE_CASES;
  const selected = splitList(argCase || envCases);
  return selected.length > 0 ? selected : defaultCases;
}

function getTimeoutMs() {
  const raw = getArg("--timeout-ms", process.env.PAPER_SEARCH_SMOKE_TIMEOUT_MS);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 45_000;
}

function getCaseTimeoutMs(caseName, fallback) {
  if (caseName === "material-mineru-live") {
    return getPositiveNumber(process.env.PAPER_SEARCH_SMOKE_MINERU_TIMEOUT_MS, fallback);
  }
  if (caseName === "material-unpaywall-live") {
    return getPositiveNumber(process.env.PAPER_SEARCH_SMOKE_UNPAYWALL_TIMEOUT_MS, fallback);
  }
  return fallback;
}

function getPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getOptionalEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return { name, value: value.trim() };
    }
  }
  return undefined;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function importDistModule(relativePath) {
  const absolutePath = path.resolve("dist", relativePath);
  if (!(await pathExists(absolutePath))) {
    throw new Error(`Missing build artifact: ${absolutePath}. Run npm run build before npm run test:smoke.`);
  }
  return import(pathToFileURL(absolutePath).href);
}

async function createProviderLoader(providerRoot) {
  const { createNodeCompatibilityApi } = await importDistModule(
    path.join("providers", "runtime", "createApi.js"),
  );
  const { invokeProviderFactoryInNode } = await importDistModule(
    path.join("providers", "runtime", "invokeNodeFactory.js"),
  );
  const { parseProviderManifest } = await importDistModule(
    path.join("providers", "manifest", "validate.js"),
  );

  async function loadOfficialProvider(providerId) {
    const sourceEntry = path.join(providerRoot, "src", "providers", "packages", providerId, "index.ts");
    const manifestPath = path.join(providerRoot, "src", "providers", "packages", providerId, "manifest.json");

    if (!(await pathExists(sourceEntry)) || !(await pathExists(manifestPath))) {
      throw new Error(`Provider source not found for ${providerId} under ${providerRoot}`);
    }

    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = parseProviderManifest(manifestRaw);
    const buildResult = await esbuild.build({
      entryPoints: [sourceEntry],
      bundle: true,
      platform: "browser",
      target: "firefox115",
      format: "iife",
      globalName: "__zrs_exports",
      write: false,
      logLevel: "warning",
      legalComments: "none",
    });
    const providerJs = buildResult.outputFiles?.[0]?.text;
    if (!providerJs) {
      throw new Error(`Failed to bundle provider ${providerId}`);
    }
    return {
      providerId,
      manifest,
      bundleCode: `${providerJs}\n;globalThis.__zrs_exports = __zrs_exports;\n`,
    };
  }

  async function loadProvider(providerId, providerConfig = {}) {
    const { manifest, bundleCode } = await loadOfficialProvider(providerId);
    const api = createNodeCompatibilityApi({
      manifest,
      providerConfig,
      logger: {
        debug() {},
        info() {},
        warn(message, ...args) {
          console.warn(`[paper-search-cli][${providerId}] ${message}`, ...args);
        },
        error(message, ...args) {
          console.error(`[paper-search-cli][${providerId}] ${message}`, ...args);
        },
      },
    });
    return {
      manifest,
      ...(await invokeProviderFactoryInNode(bundleCode, manifest, api)),
    };
  }

  return { loadProvider };
}

async function loadMaterialProvider(packagePath, providerConfig, tmpRoot) {
  const { loadMaterialProviderPackage } = await importDistModule(
    path.join("material", "package", "load.js"),
  );
  const { createMaterialRuntimeContext } = await importDistModule(
    path.join("material", "runtime", "createContext.js"),
  );
  const { invokeMaterialProviderFactoryInNode } = await importDistModule(
    path.join("material", "runtime", "invokeNodeFactory.js"),
  );

  const loaded = await loadMaterialProviderPackage(packagePath);
  const runtimeContext = createMaterialRuntimeContext({
    manifest: loaded.manifest,
    providerConfig,
    policy: {
      name: "smoke-live",
      mode: "explicit",
    },
    cacheRoot: path.join(tmpRoot, "cache"),
    workspaceRoot: path.join(tmpRoot, "workspace"),
  });
  const runtime = await invokeMaterialProviderFactoryInNode(
    loaded.bundleCode,
    loaded.manifest,
    runtimeContext,
  );
  return {
    manifest: loaded.manifest,
    packagePath: loaded.packagePath,
    runtime,
  };
}

function summarizeItem(item) {
  return {
    title: item?.title,
    itemType: item?.itemType,
    DOI: item?.DOI,
    url: item?.url,
    source: item?.source,
  };
}

function collectMineruLiveConfig(caseName) {
  const token = getOptionalEnv(["MINERU_TOKEN", "MINERU_API_TOKEN"]);
  const sourceUrl = process.env.PAPER_SEARCH_SMOKE_MINERU_URL?.trim();
  const missing = [];
  if (!token) missing.push("MINERU_TOKEN or MINERU_API_TOKEN");
  if (!sourceUrl) missing.push("PAPER_SEARCH_SMOKE_MINERU_URL");
  if (missing.length > 0) {
    throw new Error(
      `${caseName} requires ${missing.join(
        " and ",
      )} when the smoke gate is enabled and the case is selected.`,
    );
  }

  let parsedSourceUrl;
  try {
    parsedSourceUrl = new URL(sourceUrl);
  } catch {
    throw new Error(`${caseName} requires PAPER_SEARCH_SMOKE_MINERU_URL to be a valid URL.`);
  }
  if (parsedSourceUrl.protocol !== "http:" && parsedSourceUrl.protocol !== "https:") {
    throw new Error(`${caseName} requires PAPER_SEARCH_SMOKE_MINERU_URL to be http(s).`);
  }

  const endpoint = getOptionalEnv(["MINERU_API_BASE", "MINERU_ENDPOINT"]);
  const timeoutMs = getPositiveNumber(
    process.env.PAPER_SEARCH_SMOKE_MINERU_TIMEOUT_MS,
    getPositiveNumber(process.env.PAPER_SEARCH_SMOKE_TIMEOUT_MS, 600_000),
  );
  const pollIntervalMs = getPositiveNumber(
    process.env.PAPER_SEARCH_SMOKE_MINERU_POLL_INTERVAL_MS,
    2_000,
  );
  const providerConfig = {
    apiToken: token.value,
    cache: false,
    timeoutMs,
    pollIntervalMs,
    ...(endpoint ? { endpoint: endpoint.value } : {}),
    ...(process.env.PAPER_SEARCH_SMOKE_MINERU_MODEL_VERSION
      ? { modelVersion: process.env.PAPER_SEARCH_SMOKE_MINERU_MODEL_VERSION }
      : {}),
    ...(process.env.PAPER_SEARCH_SMOKE_MINERU_LANGUAGE
      ? { language: process.env.PAPER_SEARCH_SMOKE_MINERU_LANGUAGE }
      : {}),
  };
  const options = {
    cache: false,
    force: true,
    ...(process.env.PAPER_SEARCH_SMOKE_MINERU_PAGE_RANGES
      ? { pageRanges: process.env.PAPER_SEARCH_SMOKE_MINERU_PAGE_RANGES }
      : {}),
  };

  return {
    providerConfig,
    options,
    sourceUrl: parsedSourceUrl.toString(),
    endpoint: endpoint?.value ?? "https://mineru.net",
    timeoutMs,
    tokenEnv: token.name,
  };
}

function collectUnpaywallLiveConfig(caseName) {
  const email = getOptionalEnv(["PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL", "UNPAYWALL_EMAIL"]);
  const doiRaw = process.env.PAPER_SEARCH_SMOKE_UNPAYWALL_DOI?.trim() || "10.1038/nature12373";
  const missing = [];
  if (!email) missing.push("PAPER_SEARCH_SMOKE_UNPAYWALL_EMAIL or UNPAYWALL_EMAIL");
  if (!doiRaw) missing.push("PAPER_SEARCH_SMOKE_UNPAYWALL_DOI");
  if (missing.length > 0) {
    throw new Error(
      `${caseName} requires ${missing.join(
        " and ",
      )} when the smoke gate is enabled and the case is selected.`,
    );
  }

  return {
    providerConfig: { email: email.value },
    doi: doiRaw,
    emailEnv: email.name,
  };
}

async function runUnpaywallMaterialLive(context) {
  const caseName = "material-unpaywall-live";
  const config = collectUnpaywallLiveConfig(caseName);
  const packagePath =
    getArg("--unpaywall-provider-package") ||
    process.env.PAPER_SEARCH_SMOKE_UNPAYWALL_PROVIDER_PACKAGE ||
    defaultUnpaywallProviderPackage;
  if (!(await pathExists(packagePath))) {
    throw new Error(
      `${caseName} requires the unpaywall distributable package at ${packagePath}. Build systems/material-providers or set PAPER_SEARCH_SMOKE_UNPAYWALL_PROVIDER_PACKAGE.`,
    );
  }
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-unpaywall-smoke-"));
  try {
    const loaded = await loadMaterialProvider(packagePath, config.providerConfig, tmpRoot);
    if (!loaded.runtime.inspection.methods.includes("resolve")) {
      throw new Error("Unpaywall material provider did not expose resolve()");
    }
    const result = await loaded.runtime.provider.resolve({
      identifier: { scheme: "doi", value: config.doi },
      policy: "smoke-live",
    });
    if (!result || typeof result !== "object" || !Array.isArray(result.candidates)) {
      throw new Error("Live Unpaywall resolve() did not return candidates");
    }
    if (result.candidates.length < 1) {
      throw new Error(`Live Unpaywall resolve() returned no OA locations for DOI ${config.doi}`);
    }
    return {
      provider: loaded.manifest.id,
      packagePath: loaded.packagePath,
      doi: config.doi,
      emailEnv: config.emailEnv,
      candidateCount: result.candidates.length,
      firstCandidateUrl: result.candidates[0]?.url ?? null,
      provenance: result.provenance ?? null,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

function assertSearchResult(providerId, result) {
  if (result?.platform !== providerId) {
    throw new Error(`Expected platform ${providerId}, got ${result?.platform}`);
  }
  if (!Array.isArray(result.items) || result.items.length < 1) {
    throw new Error(`Live ${providerId} search returned no items`);
  }
  const first = result.items[0];
  if (!first?.title || typeof first.title !== "string") {
    throw new Error(`Live ${providerId} search returned an item without a title`);
  }
}

async function runCrossrefLive(loader) {
  const providerConfig = {
    mailto: process.env.PAPER_SEARCH_SMOKE_CROSSREF_MAILTO || "paper-search-cli-smoke@example.com",
  };
  const loaded = await loader.loadProvider("crossref", providerConfig);
  if (!loaded.inspection.hasSearch) {
    throw new Error("Crossref provider did not expose search()");
  }
  const result = await loaded.provider.search("retrieval augmented generation", {
    maxResults: 1,
    sortBy: "relevance",
  });
  assertSearchResult("crossref", result);
  return {
    provider: "crossref",
    query: result.query,
    totalResults: result.totalResults,
    elapsed: result.elapsed,
    firstItem: summarizeItem(result.items[0]),
  };
}

async function runArxivLive(loader) {
  const loaded = await loader.loadProvider("arxiv", {
    sortOrder: "descending",
  });
  if (!loaded.inspection.hasSearch) {
    throw new Error("arXiv provider did not expose search()");
  }
  const result = await loaded.provider.search("graph neural network", {
    maxResults: 1,
    sortBy: "relevance",
  });
  assertSearchResult("arxiv", result);
  return {
    provider: "arxiv",
    query: result.query,
    totalResults: result.totalResults,
    elapsed: result.elapsed,
    firstItem: summarizeItem(result.items[0]),
  };
}

async function runMineruMaterialLive(context) {
  const caseName = "material-mineru-live";
  const config = collectMineruLiveConfig(caseName);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-mineru-smoke-"));
  try {
    const loaded = await loadMaterialProvider(
      context.materialProviderPackage,
      config.providerConfig,
      tmpRoot,
    );
    if (!loaded.runtime.inspection.methods.includes("extract")) {
      throw new Error("MinerU material provider did not expose extract()");
    }
    const result = await loaded.runtime.provider.extract({
      source: {
        kind: "url",
        url: config.sourceUrl,
      },
      options: config.options,
    });
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.markdown !== "string" ||
      result.markdown.trim().length === 0
    ) {
      throw new Error("Live MinerU extraction completed without Markdown output");
    }
    return {
      provider: loaded.manifest.id,
      packagePath: loaded.packagePath,
      sourceUrl: config.sourceUrl,
      endpoint: config.endpoint,
      tokenEnv: config.tokenEnv,
      markdownLength: result.markdown.length,
      cacheHit: Boolean(result.cacheHit),
      message: typeof result.message === "string" ? result.message : null,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runOpenalexLive(loader) {
  const providerConfig = {
    mailto: process.env.PAPER_SEARCH_SMOKE_OPENALEX_MAILTO || "paper-search-cli-smoke@example.com",
  };
  const loaded = await loader.loadProvider("openalex", providerConfig);
  if (!loaded.inspection.hasSearch) {
    throw new Error("OpenAlex provider did not expose search()");
  }
  const result = await loaded.provider.search("retrieval augmented generation", {
    maxResults: 1,
    sortBy: "relevance",
  });
  assertSearchResult("openalex", result);
  return {
    provider: "openalex",
    query: result.query,
    totalResults: result.totalResults,
    elapsed: result.elapsed,
    firstItem: summarizeItem(result.items[0]),
  };
}

async function runPmcLive(loader) {
  const providerConfig = {
    ...(process.env.PAPER_SEARCH_SMOKE_PMC_EMAIL
      ? { email: process.env.PAPER_SEARCH_SMOKE_PMC_EMAIL }
      : {}),
    ...(process.env.PAPER_SEARCH_SMOKE_PMC_API_KEY
      ? { apiKey: process.env.PAPER_SEARCH_SMOKE_PMC_API_KEY }
      : {}),
  };
  const loaded = await loader.loadProvider("pmc", providerConfig);
  if (!loaded.inspection.hasSearch) {
    throw new Error("PMC provider did not expose search()");
  }
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 1,
    sortBy: "relevance",
  });
  assertSearchResult("pmc", result);
  return {
    provider: "pmc",
    query: result.query,
    totalResults: result.totalResults,
    elapsed: result.elapsed,
    firstItem: summarizeItem(result.items[0]),
  };
}

async function runEuropepmcLive(loader) {
  const loaded = await loader.loadProvider("europepmc", {});
  if (!loaded.inspection.hasSearch) {
    throw new Error("Europe PMC provider did not expose search()");
  }
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 1,
    sortBy: "relevance",
  });
  assertSearchResult("europepmc", result);
  return {
    provider: "europepmc",
    query: result.query,
    totalResults: result.totalResults,
    elapsed: result.elapsed,
    firstItem: summarizeItem(result.items[0]),
  };
}

const smokeCases = {
  "crossref-live": {
    kind: "search-provider",
    run: async (context) => runCrossrefLive(await context.getProviderLoader()),
  },
  "arxiv-live": {
    kind: "search-provider",
    run: async (context) => runArxivLive(await context.getProviderLoader()),
  },
  "openalex-live": {
    kind: "search-provider",
    run: async (context) => runOpenalexLive(await context.getProviderLoader()),
  },
  "pmc-live": {
    kind: "search-provider",
    run: async (context) => runPmcLive(await context.getProviderLoader()),
  },
  "europepmc-live": {
    kind: "search-provider",
    run: async (context) => runEuropepmcLive(await context.getProviderLoader()),
  },
  "material-mineru-live": {
    kind: "material-provider",
    run: runMineruMaterialLive,
  },
  "material-unpaywall-live": {
    kind: "material-provider",
    run: runUnpaywallMaterialLive,
  },
};

async function withTimeout(label, timeoutMs, fn) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const envVar = process.env.PAPER_SEARCH_SMOKE_ENV_VAR || "PAPER_SEARCH_RUN_SMOKE";
  const raw = process.env[envVar];
  const selectedCases = pickCases();
  if (!parseTruthy(raw)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          enabled: false,
          skipped: true,
          envVar,
          selectedCases,
          availableCases: Object.keys(smokeCases),
          message: `Smoke tests skipped. Set ${envVar}=1 to run live smoke cases.`,
        },
        null,
        2,
      ),
    );
    return;
  }

  const providerRoot =
    getArg("--provider-root") ||
    process.env.PAPER_SEARCH_PROVIDER_SOURCE ||
    defaultProviderRoot;
  const materialProviderPackage =
    getArg("--material-provider-package") ||
    process.env.PAPER_SEARCH_SMOKE_MATERIAL_PROVIDER_PACKAGE ||
    defaultMaterialProviderPackage;
  const timeoutMs = getTimeoutMs();
  const unknownCases = selectedCases.filter((entry) => !smokeCases[entry]);
  if (unknownCases.length > 0) {
    throw new Error(
      `Unknown smoke case(s): ${unknownCases.join(", ")}. Available cases: ${Object.keys(smokeCases).join(", ")}`,
    );
  }

  let providerLoaderPromise;
  const context = {
    providerRoot,
    materialProviderPackage,
    getProviderLoader() {
      providerLoaderPromise ??= createProviderLoader(providerRoot);
      return providerLoaderPromise;
    },
  };
  const results = [];
  for (const caseName of selectedCases) {
    const startedAt = Date.now();
    const caseTimeoutMs = getCaseTimeoutMs(caseName, timeoutMs);
    const data = await withTimeout(caseName, caseTimeoutMs, () => smokeCases[caseName].run(context));
    results.push({
      case: caseName,
      kind: smokeCases[caseName].kind,
      ok: true,
      timeoutMs: caseTimeoutMs,
      durationMs: Date.now() - startedAt,
      data,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        enabled: true,
        providerRoot,
        materialProviderPackage,
        cases: results,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        enabled: true,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
