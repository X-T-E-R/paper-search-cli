import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProviderRoot = path.resolve(scriptDir, "..", "..", "resource-search-providers");
const defaultProviderIds = [
  "acm",
  "arxiv",
  "biorxiv",
  "core",
  "crossref",
  "dblp",
  "europepmc",
  "iacr",
  "ieee",
  "medrxiv",
  "openaire",
  "openalex",
  "openreview",
  "patentstar",
  "pmc",
  "pubmed",
  "sciencedirect",
  "scopus",
  "semantic",
  "springer",
  "usenix",
  "wos",
  "zjusummon",
];

function getArg(flag, fallback = undefined) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }
  return process.argv[index + 1];
}

const providerRoot =
  getArg("--provider-root") ||
  process.env.PAPER_SEARCH_PROVIDER_SOURCE ||
  defaultProviderRoot;
const providerArg = getArg("--provider", "all");
const providerIds =
  providerArg === "all"
    ? defaultProviderIds
    : providerArg.split(",").map((entry) => entry.trim()).filter(Boolean);

const distRoot = path.resolve("dist");
const { createNodeCompatibilityApi } = await import(
  pathToFileURL(path.join(distRoot, "providers", "runtime", "createApi.js")).href,
);
const { invokeProviderFactoryInNode } = await import(
  pathToFileURL(path.join(distRoot, "providers", "runtime", "invokeNodeFactory.js")).href,
);
const { installProviderFromZipFile } = await import(
  pathToFileURL(path.join(distRoot, "providers", "install", "zip.js")).href,
);
const { loadProviderPackage } = await import(
  pathToFileURL(path.join(distRoot, "providers", "package", "load.js")).href,
);
const providerRegistryPath = path.join(providerRoot, "registry.json");
const providerRegistry = JSON.parse(await readFile(providerRegistryPath, "utf8"));
const registryEntries = new Map(
  (providerRegistry.providers ?? []).map((entry) => [entry.id, entry]),
);
const publishedIds = [...registryEntries.keys()].sort();
if (JSON.stringify(publishedIds) !== JSON.stringify([...defaultProviderIds].sort())) {
  throw new Error(
    `Published provider set differs from the compatibility matrix: ${publishedIds.join(", ")}`,
  );
}
const compatInstallRoot = await mkdtemp(path.join(os.tmpdir(), "paper-search-provider-compat-"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadOfficialProvider(providerId) {
  const registryEntry = registryEntries.get(providerId);
  if (!registryEntry) {
    throw new Error(`Provider ${providerId} is not published in ${providerRegistryPath}`);
  }
  const zipPath = path.join(providerRoot, "dist", `${providerId}.zip`);
  const archiveBytes = await readFile(zipPath);
  const archiveHash = sha256(archiveBytes);
  if (archiveHash !== registryEntry.sha256) {
    throw new Error(`Registry checksum mismatch for ${providerId}`);
  }
  const installed = await installProviderFromZipFile(zipPath, compatInstallRoot, {
    id: registryEntry.id,
    version: registryEntry.version,
    sha256: registryEntry.sha256,
  });
  const loadedPackage = await loadProviderPackage(installed.installPath);
  const manifest = loadedPackage.manifest;
  if (manifest.id !== registryEntry.id || manifest.version !== registryEntry.version) {
    throw new Error(`Published ZIP identity mismatch for ${providerId}`);
  }
  return {
    providerId,
    manifest,
    bundleCode: loadedPackage.bundleCode,
    archiveHash,
  };
}

let apiSequence = 0;
function createCompatApi({ manifest, providerConfig = {}, globalPrefs = {}, transport }) {
  let clock = 0;
  apiSequence += 1;
  return createNodeCompatibilityApi({
    manifest,
    providerConfig,
    globalPrefs,
    ...(transport ? { transport } : {}),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    rateLimit: {
      stateKey: `compat-${manifest.id}-${apiSequence}`,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  });
}

async function inspectProvider(bundleCode, manifest, api) {
  return invokeProviderFactoryInNode(bundleCode, manifest, api);
}

async function runCrossrefProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("crossref");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: {},
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            message: {
              "total-results": 1,
              items: [
                {
                  DOI: "10.1234/paper-search-cli",
                  title: ["Runtime compatibility probe"],
                  author: [{ family: "Doe", given: "Jane" }],
                  type: "journal-article",
                  URL: "https://doi.org/10.1234/paper-search-cli",
                  "container-title": ["Journal of CLI Compatibility"],
                  "published-online": { "date-parts": [[2024, 6, 24]] },
                  publisher: "Paper Search CLI Lab",
                  "is-referenced-by-count": 7,
                },
              ],
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("retrieval augmented generation", {
    maxResults: 5,
    year: "2024",
    sortBy: "relevance",
  });

  if (!loaded.inspection.hasSearch) {
    throw new Error("Crossref inspection did not expose search()");
  }
  if (result.platform !== providerId) {
    throw new Error(`Expected platform ${providerId}, got ${result.platform}`);
  }
  if (result.items.length !== 1 || result.items[0]?.DOI !== "10.1234/paper-search-cli") {
    throw new Error("Crossref compatibility probe returned an unexpected search result");
  }
  const request = seenRequests[0];
  if (request?.options?.params?.mailto !== undefined) {
    throw new Error("Crossref injected an unconfigured mailto value");
  }
  if (request.options.params.filter !== "from-pub-date:2024,until-pub-date:2024") {
    throw new Error(`Unexpected Crossref filter mapping: ${request.options.params.filter}`);
  }

  return {
    ok: true,
    providerId,
    inspection: loaded.inspection,
    request,
    result,
  };
}

async function runAcmProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("acm");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { mailto: "compat@example.com" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            status: "ok",
            message: {
              "total-results": 7,
              items: [
                {
                  DOI: "10.1145/compat.acm",
                  title: ["Runtime Compatibility ACM View"],
                  author: [{ family: "Doe", given: "Jane" }],
                  type: "proceedings-article",
                  URL: "https://doi.org/10.1145/compat.acm",
                  "container-title": ["ACM Compatibility Conference"],
                  published: { "date-parts": [[2024, 7, 14]] },
                  "is-referenced-by-count": 5,
                },
              ],
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("systems security", {
    maxResults: 2,
    page: 2,
    year: "2023-2024",
    sortBy: "citations",
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (!loaded.inspection.hasSearch) {
    throw new Error("ACM inspection did not expose search()");
  }
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "10.1145/compat.acm"
  ) {
    throw new Error("ACM compatibility probe did not preserve view platform/source identity");
  }
  if (
    item.url !== "https://dl.acm.org/doi/10.1145/compat.acm" ||
    !item.extra?.includes("Backing source: Crossref")
  ) {
    throw new Error("ACM compatibility probe did not normalize the Crossref-backed view metadata");
  }
  if (
    request?.options?.params?.query !== "systems security" ||
    request.options.params.rows !== 20 ||
    request.options.params.offset !== 2 ||
    request.options.params.sort !== "is-referenced-by-count" ||
    request.options.params.mailto !== "compat@example.com" ||
    request.options.params.filter !==
      "prefix:10.1145,from-pub-date:2023,until-pub-date:2024"
  ) {
    throw new Error("ACM compatibility probe observed an unexpected Crossref request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runCoreProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("core");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-core-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            totalHits: 13,
            results: [
              {
                id: 4242,
                title: "<b>Runtime</b> Compatibility CORE",
                authors: [{ name: "Jane Doe" }],
                abstract: "<p>Repository compatibility fixture.</p>",
                doi: "https://doi.org/10.1234/core-compat",
                publishedDate: "2024-07-14",
                url: "https://core.ac.uk/works/4242",
                downloadUrl: "https://core.ac.uk/download/4242.pdf",
                subjects: ["Open Access"],
                repository: { name: "Compatibility Repository" },
                citationCount: 6,
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("open repositories", {
    maxResults: 5,
    page: 3,
    year: "2024",
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "4242"
  ) {
    throw new Error("CORE compatibility probe did not preserve platform/source identity");
  }
  if (item.title !== "Runtime Compatibility CORE" || item.DOI !== "10.1234/core-compat") {
    throw new Error("CORE compatibility probe did not normalize title and DOI metadata");
  }
  if (
    request?.url !== "https://api.core.ac.uk/v3/search/works/" ||
    request?.options?.params?.q !== "open repositories" ||
    request.options.params.limit !== 5 ||
    request.options.params.offset !== 10 ||
    request.options.params.year !== "2024" ||
    request.options.headers.Authorization !== "Bearer compat-core-key"
  ) {
    throw new Error("CORE compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runDblpProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("dblp");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            result: {
              hits: {
                "@total": "9",
                hit: {
                  "@id": "dblp-compat-hit",
                  "@score": "2.5",
                  info: {
                    authors: { author: [{ text: "Jane Doe" }, { text: "John Roe" }] },
                    title: "Runtime Compatibility DBLP",
                    venue: "Compatibility Conference",
                    year: "2024",
                    type: "Conference and Workshop Papers",
                    key: "conf/compat/Doe24",
                    doi: "10.1234/dblp-compat",
                    ee: "https://doi.org/10.1234/dblp-compat",
                    url: "https://dblp.org/rec/conf/compat/Doe24",
                  },
                },
              },
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graph systems", {
    maxResults: 3,
    page: 2,
    author: "Jane Doe",
    year: "2024",
    extra: { venue: "Compatibility Conference" },
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "conf/compat/Doe24"
  ) {
    throw new Error("DBLP compatibility probe did not preserve platform/source identity");
  }
  if (item.itemType !== "conferencePaper" || item.relevanceScore !== 2.5) {
    throw new Error("DBLP compatibility probe did not normalize type and score metadata");
  }
  if (
    request?.options?.params?.q !==
      "graph systems author:Jane Doe Compatibility Conference 2024" ||
    request.options.params.h !== 3 ||
    request.options.params.f !== 3 ||
    request.options.params.format !== "json"
  ) {
    throw new Error("DBLP compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runArxivProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("arxiv");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: {
      sortOrder: "ascending",
    },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/abs/2406.12345v1</id>
    <title>Runtime XML Compatibility Probe</title>
    <summary>Provider XML helpers should parse Atom responses.</summary>
    <published>2024-06-24T00:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <author><name>John Roe</name></author>
    <category term="cs.IR" />
    <category term="cs.AI" />
    <link rel="alternate" href="https://arxiv.org/abs/2406.12345v1" />
    <link title="pdf" href="https://arxiv.org/pdf/2406.12345v1" />
    <arxiv:doi>10.1234/arxiv-runtime-probe</arxiv:doi>
  </entry>
</feed>`,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/atom+xml" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("retrieval augmented generation", {
    maxResults: 1,
    author: "Jane Doe",
    sortBy: "date",
  });

  if (!loaded.inspection.hasSearch) {
    throw new Error("arXiv inspection did not expose search()");
  }
  if (result.platform !== providerId || result.items.length !== 1) {
    throw new Error("arXiv compatibility probe returned an unexpected search result");
  }
  const item = result.items[0];
  if (item?.DOI !== "10.1234/arxiv-runtime-probe") {
    throw new Error(`arXiv XML helper did not parse namespaced DOI: ${item?.DOI}`);
  }
  if (item.creators?.length !== 2 || item.tags?.length !== 2) {
    throw new Error("arXiv XML helper did not parse repeated author/category elements");
  }
  if (result.totalResults !== 2 || result.hasMore !== true) {
    throw new Error("arXiv probe did not preserve OpenSearch pagination metadata");
  }
  const request = seenRequests[0];
  if (request.options.params.search_query !== "all:retrieval augmented generation+AND+au:Jane Doe") {
    throw new Error(`Unexpected arXiv query mapping: ${request.options.params.search_query}`);
  }
  if (request.options.params.sortBy !== "submittedDate" || request.options.params.sortOrder !== "ascending") {
    throw new Error("arXiv sort mapping/config was not applied");
  }

  return {
    ok: true,
    providerId,
    inspection: loaded.inspection,
    request,
    result,
  };
}

async function runIacrProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("iacr");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: `<!doctype html>
<html>
  <head><title>IACR ePrint search</title></head>
  <body>
    <div class="mb-4">
      <div class="d-flex">
        <a class="paperlink" href="/2024/1234">2024/1234</a>
        <small class="ms-auto">Submitted 2024-07-14</small>
      </div>
      <div class="ms-md-4">
        <strong>Runtime Compatibility IACR</strong>
        <span class="fst-italic">Jane Doe and John Roe</span>
        <p class="search-abstract">An offline HTML compatibility fixture.</p>
        <small class="badge">Public-key cryptography</small>
      </div>
      <a href="/2024/1234.pdf">PDF</a>
    </div>
  </body>
</html>`,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("threshold signatures", {
    maxResults: 1,
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "2024/1234"
  ) {
    throw new Error("IACR compatibility probe did not preserve platform/source identity");
  }
  if (
    item.date !== "2024-07-14" ||
    item.url !== "https://eprint.iacr.org/2024/1234" ||
    item.creators?.length !== 2
  ) {
    throw new Error("IACR compatibility probe did not normalize the HTML fixture");
  }
  if (
    request?.url !== "https://eprint.iacr.org/search" ||
    request.options?.params?.q !== "threshold signatures" ||
    !String(request.options?.headers?.Accept).includes("text/html")
  ) {
    throw new Error("IACR compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runIeeeProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("ieee");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-ieee-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            total_records: "15",
            articles: [
              {
                article_number: "99887766",
                title: "<b>Runtime</b> Compatibility IEEE",
                authors: {
                  authors: [
                    { full_name: "John Roe", author_order: 2 },
                    { full_name: "Jane Doe", author_order: 1 },
                  ],
                },
                abstract: "<p>IEEE metadata compatibility fixture.</p>",
                doi: "https://doi.org/10.1234/ieee-compat",
                html_url: "https://ieeexplore.ieee.org/document/99887766",
                publication_title: "IEEE Compatibility Journal",
                publication_year: "2024",
                publication_date: "14 July 2024",
                citing_paper_count: "8",
                index_terms: { ieee_terms: { terms: ["Compatibility"] } },
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graph accelerators", {
    maxResults: 4,
    page: 2,
    author: "Jane Doe",
    year: "2024",
    sortBy: "citations",
    extra: {
      articleTitle: "Compatibility",
      journal: "IEEE Compatibility Journal",
      sortOrder: "asc",
    },
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "99887766"
  ) {
    throw new Error("IEEE compatibility probe did not preserve platform/source identity");
  }
  if (
    item.title !== "Runtime Compatibility IEEE" ||
    item.DOI !== "10.1234/ieee-compat" ||
    item.creators?.[0]?.lastName !== "Doe"
  ) {
    throw new Error("IEEE compatibility probe did not normalize title, DOI, and author order");
  }
  if (
    request?.options?.params?.apikey !== "compat-ieee-key" ||
    request.options.params.querytext !== "graph accelerators" ||
    request.options.params.max_records !== 4 ||
    request.options.params.start_record !== 5 ||
    request.options.params.author !== "Jane Doe" ||
    request.options.params.publication_year !== "2024" ||
    request.options.params.article_title !== "Compatibility" ||
    request.options.params.publication_title !== "IEEE Compatibility Journal" ||
    request.options.params.sort_field !== "citing_paper_count" ||
    request.options.params.sort_order !== "asc"
  ) {
    throw new Error("IEEE compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runPatentstarProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("patentstar");
  const seenRequests = [];
  let forceDetailFailure = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers ?? {});
    const cookie = headers.get("cookie") ?? "";
    const body = typeof init.body === "string" ? init.body : undefined;
    seenRequests.push({
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(headers.entries()),
      body,
    });

    if (url.endsWith("/Account/UserLogin")) {
      return new Response(JSON.stringify({ Ret: 200, Msg: "ok" }), {
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["set-cookie", "SESSION=compat-patentstar; Path=/; HttpOnly"],
        ],
      });
    }

    if (!cookie.includes("SESSION=compat-patentstar")) {
      return new Response(JSON.stringify({ Ret: 401, Msg: "请登录" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/Search/SearchByQuery")) {
      return new Response(
        JSON.stringify({
          Ret: 200,
          Data: {
            HitCount: 1,
            List: [
              {
                AN: "CN20240001A",
                AD: "20240102",
                PN: "CN123456",
                PD: "20240624",
                TI: "Runtime Compatibility Patent",
                GJ: "CN",
                PA: "Paper Search CLI Lab",
                IN: "Jane Doe;John Roe",
                AB: "A patent detail compatibility probe",
                LG: "valid",
                ANE: "ANE-001",
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.endsWith("/Search/GetPatentByIDE")) {
      return new Response(
        JSON.stringify({
          Ret: 200,
          Data: {
            Patent: {
              AN: "CN20240001A",
              AD: "20240102",
              PN: "CN123456",
              PD: "20240624",
              TI: "Runtime Compatibility Patent",
              GJ: "CN",
              PA: "Paper Search CLI Lab",
              IN: "Jane Doe;John Roe",
              AB: "A patent detail compatibility probe",
              LG: "valid",
              ANE: "ANE-001",
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.endsWith("/WebService/GetFLZT")) {
      return new Response(
        JSON.stringify(
          forceDetailFailure
            ? { Ret: 500, Msg: "compat detail failure" }
            : {
                Ret: 200,
                Data: [{ LegalDate: "20240203", LegalStatus: "valid", LegalStatusInfo: "granted" }],
              },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.endsWith("/WebService/GetPDFUrl")) {
      return new Response(JSON.stringify({ Ret: 200, Data: ["https://example.com/patent.pdf"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/WebService/GetCLInfo")) {
      return new Response(JSON.stringify({ Ret: 200, Data: "<claims><p>1. A compatibility claim.</p></claims>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/WebService/GetDSInfo")) {
      return new Response(JSON.stringify({ Ret: 200, Data: "<description><p>Detailed description</p></description>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/WebService/GetWGIMG")) {
      return new Response(JSON.stringify({ Ret: 200, Data: ["https://example.com/patent.png"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected compat URL: ${url}`);
  };

  try {
    const api = createCompatApi({
      manifest,
      providerConfig: {
        loginName: "compat-user",
        password: "compat-password",
      },
    });

    const loaded = await inspectProvider(bundleCode, manifest, api);
    const result = await loaded.provider.search("graphene sensor", {
      maxResults: 5,
      page: 1,
      sortBy: "date",
      extra: {
        database: "CN",
        patentType: "invention",
      },
    });
    const detail = await loaded.provider.getDetail?.("ANE-001", {
      include: ["legalStatus", "claims", "pdf"],
    });

    if (!loaded.inspection.hasSearch || !loaded.inspection.hasGetDetail) {
      throw new Error("PatentStar inspection did not expose search() + getDetail()");
    }
    if (result.platform !== providerId || result.items.length !== 1) {
      throw new Error("PatentStar compatibility probe returned an unexpected search result");
    }
    if (!detail?.detail.claims?.text?.includes("compatibility claim")) {
      throw new Error("PatentStar compatibility probe did not return claims text");
    }
    forceDetailFailure = true;
    let rejectedDetailFailure = false;
    try {
      await loaded.provider.getDetail?.("ANE-001", { include: ["legalStatus"] });
    } catch (error) {
      rejectedDetailFailure = String(error).includes("compat detail failure");
    }
    if (!rejectedDetailFailure) {
      throw new Error("PatentStar accepted a non-authentication detail API failure");
    }
    const searchRequests = seenRequests.filter((entry) => entry.url.endsWith("/Search/SearchByQuery"));
    const detailRequests = seenRequests.filter((entry) => entry.url.endsWith("/Search/GetPatentByIDE"));
    if (!searchRequests.some((entry) => entry.headers?.cookie?.includes("SESSION=compat-patentstar"))) {
      throw new Error("PatentStar retried search did not receive the login session cookie");
    }
    if (!detailRequests.some((entry) => entry.headers?.cookie?.includes("SESSION=compat-patentstar"))) {
      throw new Error("PatentStar detail did not receive the login session cookie");
    }

    return {
      ok: true,
      providerId,
      inspection: loaded.inspection,
      requests: seenRequests,
      result,
      detail,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runOpenaireProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("openaire");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-openaire-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            header: { numFound: 8, page: 2, pageSize: 4 },
            results: [
              {
                id: "openaire::compat-42",
                mainTitle: "Runtime Compatibility OpenAIRE",
                subTitle: "Graph API fixture",
                type: "publication",
                publicationDate: "2024-07-14",
                descriptions: [{ value: "OpenAIRE JSON metadata compatibility fixture." }],
                authors: [{ fullName: "Doe, Jane", rank: 1 }],
                pids: [{ scheme: "doi", value: "10.1234/openaire-compat" }],
                bestAccessRight: { label: "Open Access" },
                container: { name: "OpenAIRE Compatibility Journal", sp: "1", ep: "9" },
                instances: [
                  {
                    urls: [
                      "https://openaire.eu/result/compat-42.pdf",
                      "https://openaire.eu/result/compat-42",
                    ],
                  },
                ],
                indicators: { citationImpact: { citationCount: 7 } },
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("open science graphs", {
    maxResults: 4,
    page: 2,
    year: "2024",
    sortBy: "citations",
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "openaire::compat-42"
  ) {
    throw new Error("OpenAIRE compatibility probe did not preserve platform/source identity");
  }
  if (
    item.title !== "Runtime Compatibility OpenAIRE: Graph API fixture" ||
    item.DOI !== "10.1234/openaire-compat" ||
    item.creators?.[0]?.lastName !== "Doe" ||
    item.citationCount !== 7
  ) {
    throw new Error("OpenAIRE compatibility probe did not normalize JSON metadata");
  }
  if (
    request?.url !== "https://api.openaire.eu/graph/v3/research-products" ||
    request.options?.params?.search !== "open science graphs" ||
    request.options.params.type !== "publication" ||
    request.options.params.page !== 2 ||
    request.options.params.pageSize !== 4 ||
    request.options.params.publicationYear !== "2024" ||
    request.options.params.sortBy !== "citationCount DESC" ||
    request.options.headers.Authorization !== "Bearer compat-openaire-key"
  ) {
    throw new Error("OpenAIRE compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runOpenreviewProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("openreview");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            count: 6,
            notes: [
              {
                id: "openreview-compat-note",
                forum: "openreview-compat-forum",
                invitation: "Compatibility.cc/2024/Conference/-/Submission",
                domain: "compatibility.cc",
                pdate: Date.UTC(2024, 6, 14),
                content: {
                  title: { value: "Runtime Compatibility OpenReview" },
                  authors: { value: ["Jane Doe", "John Roe"] },
                  authorids: { value: ["~Jane_Doe1", "~John_Roe1"] },
                  abstract: { value: "OpenReview compatibility fixture." },
                  venue: { value: "Compatibility Conference 2024" },
                  pdf: { value: "/pdf?id=openreview-compat-note" },
                  html: { value: "https://doi.org/10.1234/openreview-compat" },
                },
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("reviewed graph models", {
    maxResults: 2,
    page: 2,
    year: "2024",
    author: "Jane Doe",
    extra: { venue: "Compatibility Conference" },
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "openreview-compat-note"
  ) {
    throw new Error("OpenReview compatibility probe did not preserve platform/source identity");
  }
  if (
    item.DOI !== "10.1234/openreview-compat" ||
    item.date !== "2024-07-14" ||
    item.url !== "https://openreview.net/forum?id=openreview-compat-forum"
  ) {
    throw new Error("OpenReview compatibility probe did not normalize DOI, date, and forum URL");
  }
  if (
    request?.options?.params?.term !== "reviewed graph models" ||
    request.options.params.limit !== 2 ||
    request.options.params.offset !== 2
  ) {
    throw new Error("OpenReview compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runOpenalexProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("openalex");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: {
      mailto: "compat@example.com",
    },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            meta: { count: 1, page: 1, per_page: 5 },
            results: [
              {
                id: "https://openalex.org/W123456789",
                doi: "https://doi.org/10.1234/openalex-compat",
                title: "Runtime compatibility probe",
                publication_year: 2024,
                cited_by_count: 3,
                open_access: { is_oa: true, oa_status: "gold", oa_url: "https://example.org/oa" },
                best_oa_location: {
                  pdf_url: "https://example.org/oa.pdf",
                  landing_page_url: "https://example.org/oa",
                },
                authorships: [{ author: { display_name: "Jane Doe" } }],
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("retrieval augmented generation", {
    maxResults: 5,
    year: "2024-2025",
    sortBy: "relevance",
  });

  if (!loaded.inspection.hasSearch) {
    throw new Error("OpenAlex inspection did not expose search()");
  }
  if (result.platform !== providerId || result.items.length !== 1) {
    throw new Error("OpenAlex compatibility probe returned an unexpected search result");
  }
  if (!result.items[0]?.extra?.includes("OA PDF")) {
    throw new Error("OpenAlex probe did not expose OA link metadata in extra");
  }
  const request = seenRequests[0];
  if (!request?.url?.includes("api.openalex.org/works")) {
    throw new Error(`Unexpected OpenAlex URL: ${request?.url}`);
  }
  if (request.options?.params?.mailto !== "compat@example.com") {
    throw new Error("OpenAlex did not receive config-backed mailto");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runPmcProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("pmc");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: {
      email: "compat@example.com",
      tool: "paper-search-compat",
    },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        if (String(url).includes("esearch.fcgi")) {
          return {
            data: `<?xml version="1.0"?><eSearchResult><Count>1</Count><IdList><Id>12345</Id></IdList></eSearchResult>`,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/xml" },
          };
        }
        if (String(url).includes("esummary.fcgi")) {
          return {
            data: `<?xml version="1.0"?><eSummaryResult><DocSum><Id>12345</Id><Item Name="Title" Type="String">Runtime Compatibility PMC</Item><Item Name="FullJournalName" Type="String">Journal of CLI Compatibility</Item><Item Name="PubDate" Type="String">2024 Jun</Item><Item Name="AuthorList" Type="List"><Item Name="Author" Type="String">Jane Doe</Item></Item><Item Name="ArticleIds" Type="List"><Item Name="pmcid" Type="String">PMC99999</Item><Item Name="pmid" Type="String">9876543</Item><Item Name="doi" Type="String">10.1234/pmc-compat</Item></Item></DocSum></eSummaryResult>`,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/xml" },
          };
        }
        throw new Error(`Unexpected PMC compat URL: ${url}`);
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    sortBy: "relevance",
    year: "2024-2025",
  });

  if (!loaded.inspection.hasSearch) {
    throw new Error("PMC inspection did not expose search()");
  }
  if (result.platform !== providerId || result.items.length !== 1) {
    throw new Error("PMC compatibility probe returned an unexpected search result");
  }
  if (!result.items[0]?.extra?.includes("PMC PDF")) {
    throw new Error("PMC probe did not expose full-text link metadata");
  }
  const esearch = seenRequests.find((entry) => String(entry.url).includes("esearch.fcgi"));
  if (esearch?.options?.params?.db !== "pmc") {
    throw new Error("PMC esearch did not target db=pmc");
  }
  if (!String(esearch?.options?.params?.term).includes("2024:2025[Publication Date]")) {
    throw new Error(`Unexpected PMC publication-year mapping: ${esearch?.options?.params?.term}`);
  }

  return { ok: true, providerId, inspection: loaded.inspection, requests: seenRequests, result };
}

async function runEuropepmcProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("europepmc");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: {},
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        const firstPage = options?.params?.cursorMark === "*";
        return {
          data: {
            hitCount: 2,
            nextCursorMark: firstPage ? "cursor-page-2" : "cursor-page-3",
            resultList: {
              result: [
                {
                  id: firstPage ? "111111" : "222222",
                  pmid: firstPage ? "111111" : "222222",
                  source: "MED",
                  title: "Runtime Compatibility Europe PMC",
                  authorString: "Doe J",
                  pubYear: "2024",
                  isOpenAccess: "Y",
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        url: "https://example.org/europepmc.pdf",
                        documentStyle: "pdf",
                        availability: "Open access",
                      },
                    ],
                  },
                },
              ],
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    page: 2,
    sortBy: "date",
  });

  if (!loaded.inspection.hasSearch) {
    throw new Error("Europe PMC inspection did not expose search()");
  }
  if (result.platform !== providerId || result.items.length !== 1) {
    throw new Error("Europe PMC compatibility probe returned an unexpected search result");
  }
  const firstRequest = seenRequests[0];
  const secondRequest = seenRequests[1];
  if (!String(firstRequest?.url).includes("europepmc/webservices/rest/search")) {
    throw new Error(`Unexpected Europe PMC URL: ${firstRequest?.url}`);
  }
  if (firstRequest.options?.params?.resultType !== "core" || firstRequest.options?.params?.format !== "json") {
    throw new Error("Europe PMC probe did not send core/json search params");
  }
  if (
    firstRequest.options.params.cursorMark !== "*" ||
    secondRequest?.options?.params?.cursorMark !== "cursor-page-2" ||
    secondRequest?.options?.params?.sort !== "P_PDATE_D desc"
  ) {
    throw new Error("Europe PMC probe did not walk cursor pagination with documented sort syntax");
  }
  if (result.items[0]?.url !== "https://europepmc.org/article/MED/222222") {
    throw new Error(`Unexpected Europe PMC PMID URL: ${result.items[0]?.url}`);
  }

  return { ok: true, providerId, inspection: loaded.inspection, requests: seenRequests, result };
}

async function runPreprintProbe(providerId) {
  const { manifest, bundleCode } = await loadOfficialProvider(providerId);
  const seenRequests = [];
  const firstBatch = Array.from({ length: 30 }, (_, index) => ({
    title: index === 0 ? "Compatibility first match" : `Unrelated preprint ${index}`,
    doi: `10.1101/${providerId}.first.${index}`,
    authors: "Doe, Jane; Roe, John",
    abstract: "fixture",
    date: "2024-06-24",
    version: "1",
    category: "bioinformatics",
  }));
  const secondBatch = [
    {
      title: "Compatibility second match",
      doi: `10.1101/${providerId}.second`,
      authors: "Doe, Jane",
      date: "2024-06-25",
      version: "2",
      category: "bioinformatics",
    },
    {
      title: "Compatibility third match",
      doi: `10.1101/${providerId}.third`,
      authors: "Roe, John",
      date: "2024-06-26",
      version: "1",
      category: "bioinformatics",
    },
  ];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        const collection = String(url).endsWith("/0") ? firstBatch : secondBatch;
        return {
          data: { messages: [{ count: 32 }], collection },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("compatibility", {
    maxResults: 1,
    page: 2,
    extra: { category: "bioinformatics" },
  });
  if (result.platform !== providerId || result.items[0]?.title !== "Compatibility second match") {
    throw new Error(`${providerId} filtered pagination returned an unexpected result`);
  }
  if (
    !String(seenRequests[0]?.url).endsWith("/0") ||
    !String(seenRequests[1]?.url).endsWith("/30") ||
    seenRequests[0]?.options?.params?.category !== "bioinformatics"
  ) {
    throw new Error(`${providerId} did not use raw 30-record cursors and the category parameter`);
  }
  if (result.hasMore !== true || seenRequests.length !== 2) {
    throw new Error(`${providerId} did not scan enough fixed-size API batches for filtered page 2`);
  }
  return { ok: true, providerId, inspection: loaded.inspection, requests: seenRequests, result };
}

async function runBiorxivProbe() {
  return runPreprintProbe("biorxiv");
}

async function runMedrxivProbe() {
  return runPreprintProbe("medrxiv");
}

async function runPubmedProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("pubmed");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { tool: "paper-search-compat", email: "compat@example.com" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        if (String(url).includes("esearch.fcgi")) {
          return {
            data: "<?xml version=\"1.0\"?><eSearchResult><Count>42</Count><IdList><Id>12345678</Id></IdList></eSearchResult>",
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/xml" },
          };
        }
        if (String(url).includes("efetch.fcgi")) {
          return {
            data: `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345678</PMID><Article><ArticleTitle>Runtime Compatibility PubMed.</ArticleTitle><Abstract><AbstractText>Compatibility abstract.</AbstractText></Abstract><AuthorList><Author><LastName>Doe</LastName><ForeName>Jane</ForeName></Author></AuthorList><Journal><JournalIssue><Volume>12</Volume><Issue>3</Issue><PubDate><Year>2024</Year><Month>Jun</Month><Day>24</Day></PubDate></JournalIssue><Title>Journal of CLI Compatibility</Title></Journal><Pagination><MedlinePgn>1-9</MedlinePgn></Pagination></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/pubmed-compat</ArticleId><ArticleId IdType="pmc">PMC123</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/xml" },
          };
        }
        throw new Error(`Unexpected PubMed compat URL: ${url}`);
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    year: "2020-2024",
    sortBy: "date",
  });
  const searchRequest = seenRequests.find((entry) => String(entry.url).includes("esearch.fcgi"));
  if (result.totalResults !== 42 || result.items[0]?.DOI !== "10.1234/pubmed-compat") {
    throw new Error("PubMed compatibility probe did not preserve count or article metadata");
  }
  if (!String(searchRequest?.options?.params?.term).includes("2020:2024[Publication Date]")) {
    throw new Error(`Unexpected PubMed publication-year mapping: ${searchRequest?.options?.params?.term}`);
  }
  return { ok: true, providerId, inspection: loaded.inspection, requests: seenRequests, result };
}

async function runSciencedirectProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("sciencedirect");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-sciencedirect-key" },
    transport: {
      async get() {
        throw new Error("compat probe expects ScienceDirect to use PUT");
      },
      async post() {
        throw new Error("compat probe expects ScienceDirect to use PUT");
      },
      async put(url, body, options) {
        seenRequests.push({ method: "PUT", url, body, options });
        return {
          data: {
            totalResults: "12",
            results: [
              {
                pii: "S012345678900001X",
                title: "Runtime Compatibility ScienceDirect",
                authors: [
                  { name: "Roe, John", order: 2 },
                  { name: "Doe, Jane", order: 1 },
                ],
                publicationDate: "2024-07-14",
                doi: "10.1234/sciencedirect-compat",
                uri: "https://www.sciencedirect.com/science/article/pii/S012345678900001X",
                sourceTitle: "Journal of Runtime Compatibility",
                openAccess: true,
                volumeIssue: "Volume 7, Issue 14",
                pages: "1-12",
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("retrieval systems", {
    maxResults: 5,
    page: 3,
    year: "2020-2024",
    author: "Jane Doe",
    sortBy: "date",
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "S012345678900001X"
  ) {
    throw new Error("ScienceDirect compatibility probe did not preserve platform/source identity");
  }
  if (
    item.DOI !== "10.1234/sciencedirect-compat" ||
    item.creators?.[0]?.lastName !== "Doe" ||
    !item.extra?.includes("Open Access: Yes")
  ) {
    throw new Error("ScienceDirect compatibility probe did not normalize DOI, authors, and OA metadata");
  }
  if (
    request?.method !== "PUT" ||
    request.body?.qs !== "retrieval systems" ||
    request.body?.display?.offset !== 10 ||
    request.body?.display?.show !== 5 ||
    request.body?.display?.sortBy !== "date" ||
    request.body?.date !== "2020-2024" ||
    request.body?.authors !== "Jane Doe" ||
    request.options?.headers?.["X-ELS-APIKey"] !== "compat-sciencedirect-key"
  ) {
    throw new Error("ScienceDirect compatibility probe observed an unexpected PUT request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runScopusProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("scopus");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-scopus-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            "search-results": {
              "opensearch:totalResults": "2",
              entry: [
                {
                  "@_fa": "true",
                  "dc:title": "Runtime Compatibility Scopus",
                  "dc:creator": "Doe, Jane",
                  "prism:doi": "10.1234/scopus-compat",
                  "prism:coverDate": "2024-06-24",
                  "prism:publicationName": "Journal of CLI Compatibility",
                  "citedby-count": "9",
                  eid: "2-s2.0-compat",
                },
                { error: "upstream placeholder" },
              ],
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });
  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    year: "2020-2024",
    sortBy: "citations",
  });
  const request = seenRequests[0];
  if (result.items.length !== 1 || result.items[0]?.DOI !== "10.1234/scopus-compat") {
    throw new Error("Scopus discarded a valid @_fa entry or retained an explicit error entry");
  }
  if (
    request?.options?.headers?.["X-ELS-APIKey"] !== "compat-scopus-key" ||
    !String(request?.options?.params?.query).includes("PUBYEAR > 2019") ||
    !String(request?.options?.params?.query).includes("PUBYEAR < 2025")
  ) {
    throw new Error("Scopus did not apply credentials or inclusive year bounds");
  }
  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runSemanticProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("semantic");
  const seenRequests = [];
  const backwardFixture = {
    offset: 0,
    next: 2,
    data: [
      {
        citedPaper: {
          paperId: "1111111111111111111111111111111111111111",
          title: "Backward fixture with exact identifiers",
          abstract: "A deterministic cited-paper fixture.",
          venue: "Fixture Journal",
          year: 2023,
          citationCount: 17,
          publicationDate: "2023-05-06",
          authors: [{ authorId: "fixture-author-1", name: "Ada Lovelace" }],
          externalIds: {
            DOI: "10.1000/backward.1",
            ArXiv: "2305.00001",
          },
          url: "https://www.semanticscholar.org/paper/1111111111111111111111111111111111111111",
        },
      },
      {
        citedPaper: {
          paperId: "2222222222222222222222222222222222222222",
          title: "Backward fixture with native identity",
          year: 2022,
          authors: [{ name: "Grace Hopper" }],
          externalIds: {},
        },
      },
    ],
  };
  const forwardFixture = {
    offset: 4,
    data: [
      {
        citingPaper: {
          paperId: "3333333333333333333333333333333333333333",
          title: "Forward fixture paper",
          venue: "Fixture Conference",
          year: 2025,
          citationCount: 3,
          authors: [{ name: "Katherine Johnson" }],
          externalIds: { DOI: "10.1000/forward.1" },
        },
      },
    ],
  };
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-semantic-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        if (url.endsWith("/references")) {
          return {
            data: backwardFixture,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          };
        }
        if (url.endsWith("/citations")) {
          return {
            data: forwardFixture,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          };
        }
        return {
          data: {
            total: 3,
            data: [
              {
                paperId: "semantic-compat",
                title: "Runtime Compatibility Semantic Scholar",
                abstract: "fixture",
                venue: "Journal of CLI Compatibility",
                year: 2024,
                citationCount: 4,
                isOpenAccess: true,
                openAccessPdf: { url: "https://example.test/semantic.pdf" },
                fieldsOfStudy: ["Computer Science"],
                externalIds: { DOI: "10.1234/semantic-compat" },
                authors: [{ name: "Jane Doe" }],
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });
  const loaded = await inspectProvider(bundleCode, manifest, api);
  const expectedCitationGraph = {
    directions: ["backward", "forward"],
    targetIdentifierKinds: ["semantic", "doi", "arxiv"],
    maxPageSize: 100,
  };
  if (JSON.stringify(manifest.capabilities?.citationGraph) !== JSON.stringify(expectedCitationGraph)) {
    throw new Error("Semantic Scholar ZIP did not declare the expected citationGraph capability");
  }
  if (!loaded.inspection.hasSearch || !loaded.inspection.hasGetCitationPage) {
    throw new Error("Semantic Scholar ZIP did not expose search() and getCitationPage()");
  }
  const getCitationPage = loaded.provider.getCitationPage;
  if (!getCitationPage) {
    throw new Error("Semantic Scholar host runtime did not load getCitationPage()");
  }
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 1,
    page: 2,
    year: "2024",
    extra: { fieldsOfStudy: "Computer Science" },
  });
  const request = seenRequests[0];
  if (result.items[0]?.DOI !== "10.1234/semantic-compat" || result.hasMore !== true) {
    throw new Error("Semantic Scholar compatibility probe returned unexpected metadata");
  }
  if (
    request?.url !== "https://api.semanticscholar.org/graph/v1/paper/search" ||
    request.options.params.query !== "graphene sensor" ||
    request.options.params.limit !== 1 ||
    request?.options?.headers?.["x-api-key"] !== "compat-semantic-key" ||
    request?.options?.params?.offset !== 1 ||
    request?.options?.params?.fieldsOfStudy !== "Computer Science"
  ) {
    throw new Error("Semantic Scholar did not apply search endpoint, query, paging, field, or credential parameters");
  }

  const backwardTarget = {
    identifiers: { doi: "10.1000/seed" },
    item: { itemType: "journalArticle", title: "Seed paper" },
  };
  const backwardPage = await getCitationPage({
    direction: "backward",
    target: backwardTarget,
    pageSize: 2,
  });
  const backwardRequest = seenRequests[1];
  if (
    backwardRequest?.method !== "GET" ||
    backwardRequest?.url !==
      "https://api.semanticscholar.org/graph/v1/paper/DOI%3A10.1000%2Fseed/references" ||
    backwardRequest?.options?.headers?.["x-api-key"] !== "compat-semantic-key" ||
    JSON.stringify(backwardRequest?.options?.params) !==
      JSON.stringify({
        offset: 0,
        limit: 2,
        fields:
          "paperId,title,abstract,venue,year,citationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,publicationDate,journal,authors,externalIds,url",
      })
  ) {
    throw new Error("Semantic Scholar backward citation request contract drifted");
  }
  if (
    backwardPage.direction !== "backward" ||
    JSON.stringify(backwardPage.target) !== JSON.stringify(backwardTarget) ||
    backwardPage.relations.length !== 2 ||
    JSON.stringify(backwardPage.relations[0]?.identifiers) !==
      JSON.stringify({
        semantic: "1111111111111111111111111111111111111111",
        doi: "10.1000/backward.1",
        arxiv: "2305.00001",
      }) ||
    backwardPage.relations[0]?.providerNativeId !==
      "1111111111111111111111111111111111111111" ||
    backwardPage.relations[0]?.item.source !== "semantic" ||
    backwardPage.relations[0]?.item.sourceId !==
      "1111111111111111111111111111111111111111" ||
    backwardPage.relations[0]?.item.DOI !== "10.1000/backward.1" ||
    backwardPage.nextCursor !== "2" ||
    backwardPage.exhausted !== false ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(backwardPage.observedAt)
  ) {
    throw new Error("Semantic Scholar backward citation response was not normalized correctly");
  }

  const forwardTarget = {
    identifiers: { semantic: "seed-semantic-id", doi: "10.1000/fallback" },
    item: { itemType: "journalArticle", title: "Seed paper" },
  };
  const forwardPage = await getCitationPage({
    direction: "forward",
    target: forwardTarget,
    pageSize: 25,
    cursor: "4",
  });
  const forwardRequest = seenRequests[2];
  if (
    forwardRequest?.method !== "GET" ||
    forwardRequest?.url !==
      "https://api.semanticscholar.org/graph/v1/paper/seed-semantic-id/citations" ||
    forwardRequest?.options?.headers?.["x-api-key"] !== "compat-semantic-key" ||
    JSON.stringify(forwardRequest?.options?.params) !==
      JSON.stringify({
        offset: 4,
        limit: 25,
        fields:
          "paperId,title,abstract,venue,year,citationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,publicationDate,journal,authors,externalIds,url",
      })
  ) {
    throw new Error("Semantic Scholar forward citation request contract drifted");
  }
  if (
    forwardPage.direction !== "forward" ||
    JSON.stringify(forwardPage.target) !== JSON.stringify(forwardTarget) ||
    forwardPage.relations.length !== 1 ||
    JSON.stringify(forwardPage.relations[0]?.identifiers) !==
      JSON.stringify({
        semantic: "3333333333333333333333333333333333333333",
        doi: "10.1000/forward.1",
      }) ||
    forwardPage.relations[0]?.providerNativeId !==
      "3333333333333333333333333333333333333333" ||
    forwardPage.relations[0]?.item.source !== "semantic" ||
    forwardPage.relations[0]?.item.sourceId !==
      "3333333333333333333333333333333333333333" ||
    forwardPage.relations[0]?.item.DOI !== "10.1000/forward.1" ||
    forwardPage.nextCursor !== undefined ||
    forwardPage.exhausted !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(forwardPage.observedAt)
  ) {
    throw new Error("Semantic Scholar forward citation response was not normalized correctly");
  }
  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runSpringerProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("springer");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-springer-key" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            result: [{ total: "18", start: "4", pageLength: "3", recordsDisplayed: "1" }],
            records: [
              {
                identifier: "springer-compat-record",
                title: "Runtime Compatibility Springer",
                creators: [{ creator: "Doe, Jane" }, { creator: "John Roe" }],
                publicationName: "Springer Compatibility Handbook",
                publicationDate: "2024-07-14",
                doi: "10.1234/springer-compat",
                url: [
                  { format: "html", value: "https://link.springer.com/chapter/compat" },
                  { format: "pdf", value: "https://link.springer.com/content/pdf/compat.pdf" },
                ],
                abstract: "Springer metadata compatibility fixture.",
                startingPage: "10",
                endingPage: "24",
                genre: "Book Chapter",
                contentType: "Chapter",
                openaccess: "true",
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graph learning", {
    maxResults: 3,
    page: 2,
    author: "Jane Doe",
    year: "2020-2024",
    extra: {
      journal: "Compatibility Handbook",
      subject: "Computer Science",
      type: "Chapter",
    },
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "10.1234/springer-compat"
  ) {
    throw new Error("Springer compatibility probe did not preserve platform/source identity");
  }
  if (
    item.itemType !== "bookSection" ||
    item.pages !== "10-24" ||
    !item.extra?.includes("PDF: https://link.springer.com/content/pdf/compat.pdf")
  ) {
    throw new Error("Springer compatibility probe did not normalize type, pages, and PDF metadata");
  }
  const query = String(request?.options?.params?.q);
  if (
    request?.url !== "https://api.springernature.com/meta/v2/json" ||
    request.options.params.api_key !== "compat-springer-key" ||
    request.options.params.s !== 4 ||
    request.options.params.p !== 3 ||
    !query.includes('name:"Jane Doe"') ||
    !query.includes('pub:"Compatibility Handbook"') ||
    !query.includes("year:2020 TO 2024") ||
    !query.includes('subject:"Computer Science"') ||
    !query.includes("type:Chapter")
  ) {
    throw new Error("Springer compatibility probe observed an unexpected request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runUsenixProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("usenix");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            result: {
              hits: {
                "@total": "45",
                hit: [
                  {
                    "@id": "usenix-compat-hit",
                    info: {
                      authors: { author: { text: "Jane Doe" } },
                      title: "Runtime Compatibility at USENIX Security",
                      venue: "USENIX Security Symposium",
                      year: "2024",
                      type: "Conference and Workshop Papers",
                      key: "conf/uss/Doe24",
                      doi: "10.1234/usenix-compat",
                      ee: "https://www.usenix.org/conference/usenixsecurity24/presentation/doe",
                      url: "https://dblp.org/rec/conf/uss/Doe24",
                    },
                  },
                  {
                    "@id": "non-usenix-hit",
                    info: {
                      title: "Unrelated Runtime Compatibility Paper",
                      venue: "Other Conference",
                      year: "2024",
                      key: "conf/other/Roe24",
                    },
                  },
                ],
              },
            },
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });

  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("filesystem security", {
    maxResults: 2,
    author: "Jane Doe",
    year: "2024",
    extra: { venue: "Security Symposium" },
  });
  const request = seenRequests[0];
  const item = result.items[0];
  if (
    result.platform !== providerId ||
    item?.source !== providerId ||
    item?.sourceId !== "conf/uss/Doe24"
  ) {
    throw new Error("USENIX compatibility probe did not preserve view platform/source identity");
  }
  if (
    result.items.length !== 1 ||
    item.publicationTitle !== "USENIX Security Symposium" ||
    !item.extra?.includes("Backing source: DBLP")
  ) {
    throw new Error("USENIX compatibility probe did not normalize the filtered DBLP-backed view");
  }
  if (
    request?.options?.params?.q !==
      "filesystem security USENIX author:Jane Doe Security Symposium 2024" ||
    request.options.params.h !== 40 ||
    request.options.params.f !== 0 ||
    request.options.params.format !== "json"
  ) {
    throw new Error("USENIX compatibility probe observed an unexpected DBLP request mapping");
  }

  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runWosProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("wos");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    providerConfig: { apiKey: "compat-wos-key", database: "WOS" },
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            metadata: { total: 12 },
            hits: [
              {
                uid: "WOS:COMPAT",
                title: "Runtime Compatibility Web of Science",
                abstract: "fixture",
                identifiers: { doi: "10.1234/wos-compat" },
                names: { authors: [{ displayName: "Doe, Jane" }] },
                source: { publishYear: 2024, sourceTitle: "Journal of CLI Compatibility" },
                citations: [{ citingArticlesCount: 11 }],
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });
  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    year: "2020-2024",
    author: "Jane Doe",
    sortBy: "citations",
  });
  const request = seenRequests[0];
  if (result.items[0]?.DOI !== "10.1234/wos-compat" || result.totalResults !== 12) {
    throw new Error("Web of Science compatibility probe returned unexpected metadata");
  }
  if (
    request?.options?.headers?.["X-ApiKey"] !== "compat-wos-key" ||
    !String(request?.options?.params?.q).includes("PY=(2020-2024)") ||
    request?.options?.params?.sortField !== "TC+D"
  ) {
    throw new Error("Web of Science did not apply credentials, year, or sort mapping");
  }
  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

async function runZjuSummonProbe() {
  const { providerId, manifest, bundleCode } = await loadOfficialProvider("zjusummon");
  const seenRequests = [];
  const api = createCompatApi({
    manifest,
    transport: {
      async get(url, options) {
        seenRequests.push({ method: "GET", url, options });
        return {
          data: {
            recordCount: 1,
            documents: [
              {
                title: '<mark class="chinaHighlighting">Runtime</mark> Compatibility Summon',
                dois: ["10.1234/zju-compat"],
                uris: ["https://example.test/zju-compat"],
                abstracts: [{ abstract: "<b>fixture</b> abstract" }],
                publication_date: "2024-06-24T00:00:00Z",
                publication_title: "Journal of CLI Compatibility",
                authors: [{ fullname: "Jane Doe" }],
              },
            ],
          },
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        };
      },
      async post() {
        throw new Error("compat probe does not expect POST");
      },
    },
  });
  const loaded = await inspectProvider(bundleCode, manifest, api);
  const result = await loaded.provider.search("graphene sensor", {
    maxResults: 5,
    page: 2,
    year: "2024",
    author: "Jane Doe",
    sortBy: "date",
  });
  const request = seenRequests[0];
  if (result.items[0]?.title !== "Runtime Compatibility Summon") {
    throw new Error("ZJU Summon compatibility probe did not normalize highlighted HTML");
  }
  if (
    request?.options?.params?.pn !== "2" ||
    request?.options?.params?.["rf[]"] !== "PublicationDate,2024-01-01:2024-12-31" ||
    request?.options?.params?.sort !== "PublicationDate:desc"
  ) {
    throw new Error("ZJU Summon did not apply page, year, or sort mapping");
  }
  return { ok: true, providerId, inspection: loaded.inspection, request, result };
}

function compatibilityConfig(providerId) {
  switch (providerId) {
    case "patentstar":
      return { loginName: "compat-user", password: "compat-password" };
    case "ieee":
    case "sciencedirect":
    case "scopus":
    case "springer":
    case "wos":
      return { apiKey: "compat-api-key" };
    default:
      return {};
  }
}

async function runHttpFailureProbe(providerId) {
  const { manifest, bundleCode } = await loadOfficialProvider(providerId);
  const failureResponse = {
    data: { message: "rate limited" },
    status: 429,
    statusText: "Too Many Requests",
    headers: { "content-type": "application/json" },
  };
  const api = createCompatApi({
    manifest,
    providerConfig: compatibilityConfig(providerId),
    transport: {
      async get() {
        return failureResponse;
      },
      async post() {
        return failureResponse;
      },
      async put() {
        return failureResponse;
      },
    },
  });
  const loaded = await inspectProvider(bundleCode, manifest, api);
  let rejection;
  try {
    await loaded.provider.search("compatibility failure", { maxResults: 1 });
  } catch (error) {
    rejection = error;
  }
  if (
    !rejection ||
    (rejection.status !== 429 && !/\b429\b/u.test(String(rejection)))
  ) {
    throw new Error(
      `${providerId} did not propagate an HTTP 429 as a provider failure: ${String(rejection)} (status ${String(rejection?.status)})`,
    );
  }
  return { ok: true, status: 429 };
}

const probes = {
  acm: runAcmProbe,
  arxiv: runArxivProbe,
  biorxiv: runBiorxivProbe,
  core: runCoreProbe,
  crossref: runCrossrefProbe,
  dblp: runDblpProbe,
  europepmc: runEuropepmcProbe,
  iacr: runIacrProbe,
  ieee: runIeeeProbe,
  medrxiv: runMedrxivProbe,
  openaire: runOpenaireProbe,
  openalex: runOpenalexProbe,
  openreview: runOpenreviewProbe,
  patentstar: runPatentstarProbe,
  pmc: runPmcProbe,
  pubmed: runPubmedProbe,
  sciencedirect: runSciencedirectProbe,
  scopus: runScopusProbe,
  semantic: runSemanticProbe,
  springer: runSpringerProbe,
  usenix: runUsenixProbe,
  wos: runWosProbe,
  zjusummon: runZjuSummonProbe,
};

const results = [];
try {
  for (const providerId of providerIds) {
    const probe = probes[providerId];
    if (!probe) {
      throw new Error(`Compat probe not implemented for provider: ${providerId}`);
    }
    const success = await probe();
    results.push({
      ok: true,
      providerId,
      inspection: success.inspection,
      search: {
        totalResults: success.result?.totalResults,
        itemCount: success.result?.items?.length,
        hasMore: success.result?.hasMore,
      },
      httpFailure: await runHttpFailureProbe(providerId),
    });
  }
} finally {
  await rm(compatInstallRoot, { recursive: true, force: true });
}

const payload = {
  ok: true,
  providerRoot,
  providers: results,
};
console.log(JSON.stringify(providerIds.length === 1 ? { ok: true, providerRoot, ...results[0] } : payload, null, 2));
