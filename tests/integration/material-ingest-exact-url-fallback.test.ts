import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/index.js";
import type {
  MaterialIngestExactUrlExecutionData,
  MaterialIngestExecutionData,
} from "../../src/material/ingest.js";
import { setSafeExternalHttpsTestHooksForTests } from "../../src/runtime/safeExternalHttps.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { resolveDistributableMaterialPackageDir } from "../helpers/distributableMaterialProviders.js";

const tempDirs: string[] = [];
const extractorFixture = path.resolve(
  "tests",
  "fixtures",
  "material-extractors",
  "fixture-markdown-extractor",
);
const mineruFixture = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "mineru-extractor",
);
let downloaderPackageDir = "";

beforeAll(async () => {
  downloaderPackageDir = await resolveDistributableMaterialPackageDir("direct-url-downloader");
});

beforeEach(() => {
  setSafeExternalHttpsTestHooksForTests({
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    requestPinned: async (url, init) => fetch(url, init),
  });
});

afterEach(async () => {
  setSafeExternalHttpsTestHooksForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function writeFailingExtractor(providerRoot: string): Promise<void> {
  const target = path.join(providerRoot, "material", "failing-url-extractor");
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "manifest.json"),
    `${JSON.stringify({
      id: "failing-url-extractor",
      name: "Failing URL Extractor",
      version: "1.0.0",
      kind: "extractor",
      entry: "provider.js",
      capabilities: {
        inputs: ["url", "artifact"],
        inputTypes: ["pdf", "html"],
        outputs: ["markdown", "json"],
        network: false,
      },
      configSchema: {},
      permissions: { localRead: true, localWrite: "none" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(target, "provider.js"),
    [
      "globalThis.__material_provider_exports = {",
      "  createProvider() {",
      "    return { async extract() { throw new Error('managed exact-URL extraction failed'); } };",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeNonIdempotentDownloader(providerRoot: string): Promise<void> {
  const target = path.join(providerRoot, "material", "non-idempotent-downloader");
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "manifest.json"),
    `${JSON.stringify({
      id: "non-idempotent-downloader",
      name: "Non-idempotent Downloader",
      version: "1.0.0",
      kind: "downloader",
      entry: "provider.js",
      capabilities: {
        inputs: ["url"],
        inputTypes: ["pdf"],
        outputs: ["artifact"],
        network: false,
      },
      configSchema: {},
      permissions: { localRead: false, localWrite: "none" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(target, "provider.js"),
    [
      "globalThis.__material_provider_exports = {",
      "  createProvider() {",
      "    return { async acquire() { throw new Error('HTTP 403 from non-idempotent provider action'); } };",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createProject(options: {
  prefix: string;
  extractor: "fixture" | "mineru" | "failing";
}): Promise<{
  root: string;
  workspaceRoot: string;
  artifactRoot: string;
  extractionRoot: string;
  extractorId: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), options.prefix));
  tempDirs.push(root);
  const providerRoot = path.join(root, "providers");
  const workspaceRoot = path.join(root, "workspace");
  const artifactRoot = path.join(root, "artifacts");
  const extractionRoot = path.join(root, "extractions");
  await cp(
    downloaderPackageDir,
    path.join(providerRoot, "material", "direct-url-downloader"),
    { recursive: true },
  );

  let extractorId: string;
  if (options.extractor === "fixture") {
    extractorId = "fixture-markdown-extractor";
    await cp(extractorFixture, path.join(providerRoot, "material", extractorId), { recursive: true });
  } else if (options.extractor === "mineru") {
    extractorId = "mineru-extractor";
    await cp(mineruFixture, path.join(providerRoot, "material", extractorId), { recursive: true });
  } else {
    extractorId = "failing-url-extractor";
    await writeFailingExtractor(providerRoot);
  }

  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[providers]",
      `installDir = "${tomlPath(providerRoot)}"`,
      "",
      "[workspace]",
      `root = "${tomlPath(workspaceRoot)}"`,
      'defaultCollection = "Inbox"',
      "",
      "[storage]",
      `artifactRoot = "${tomlPath(artifactRoot)}"`,
      `extractionRoot = "${tomlPath(extractionRoot)}"`,
      `exportRoot = "${tomlPath(path.join(root, "exports"))}"`,
      "",
      "[material]",
      'downloadDisposition = "materialized"',
      ...(options.extractor === "mineru"
        ? [
            "",
            "[platform.mineru-extractor]",
            "pollIntervalMs = 0",
            "timeoutMs = 5000",
          ]
        : []),
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, workspaceRoot, artifactRoot, extractionRoot, extractorId };
}

async function runMaterialIngest(
  root: string,
  url: string,
  extractorId: string,
  artifactProviderId = "direct-url-downloader",
  extraArgs: string[] = [],
): Promise<ResultEnvelope> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    })
      .exitOverride()
      .parseAsync([
        "node",
        "paper-search",
        "material",
        "ingest",
        url,
        "--artifact-provider",
        artifactProviderId,
        "--extract-provider",
        extractorId,
        ...extraArgs,
        "--json",
      ]);
  } finally {
    process.chdir(originalCwd);
  }
  expect(stderr).toBe("");
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return envelope;
}

async function expectMissingOrEmpty(directory: string): Promise<void> {
  try {
    expect(await readdir(directory)).toEqual([]);
  } catch (error) {
    expect(error).toMatchObject({ code: "ENOENT" });
  }
}

describe("material ingest exact-URL extraction fallback", () => {
  it("keeps the primary byte acquisition path and does not invoke a fallback when download succeeds", async () => {
    const project = await createProject({
      prefix: "paper-search-material-primary-bytes-",
      extractor: "fixture",
    });
    const sourceUrl = "https://example.test/papers/primary.pdf";
    const sourceBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(sourceBytes, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const planEnvelope = await runMaterialIngest(
      project.root,
      sourceUrl,
      project.extractorId,
      "direct-url-downloader",
      ["--dry-run"],
    );
    expect(planEnvelope).toMatchObject({
      ok: true,
      planned: true,
      data: {
        exactUrlFallback: {
          mode: "exact_url_extraction",
          source: { kind: "url", url: sourceUrl },
          eligibleHttpStatuses: [401, 403, 429],
          artifactOnSuccess: false,
          managedProvider: { id: project.extractorId },
          terminalProvider: { id: "jina-reader", kind: "builtin" },
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope.ok).toBe(true);
    const data = envelope.data as MaterialIngestExecutionData;
    expect(data.artifact).not.toBeNull();
    expect(data.extraction).toMatchObject({
      materialInputKind: "artifact",
      source: { kind: "artifact", artifactId: data.artifact.artifactId },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(sourceUrl);
  });

  it("recovers an eligible HTTP 403 through managed MinerU exact-URL extraction without inventing an artifact", async () => {
    vi.stubEnv("MINERU_TOKEN", "process-only-exact-url-fallback-token");
    const project = await createProject({
      prefix: "paper-search-material-mineru-fallback-",
      extractor: "mineru",
    });
    const sourceUrl = "https://example.test/papers/protected.pdf";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (method === "GET" && url === sourceUrl) {
        return new Response("forbidden", { status: 403, statusText: "Forbidden" });
      }
      if (method === "POST" && url === "https://mineru.net/api/v4/extract/task") {
        return new Response(JSON.stringify({
          code: 0,
          data: { task_id: "task_exact_url_fallback", state: "submitted" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "GET" && url === "https://mineru.net/api/v4/extract/task/task_exact_url_fallback") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            task_id: "task_exact_url_fallback",
            state: "done",
            markdown: "# Recovered through MinerU\n",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope).toMatchObject({
      ok: true,
      capability: "orchestrate",
      tool: "material_ingest",
      diagnostics: {
        acquisitionHttpStatusCodes: [403],
        sourceCounts: { artifacts: 0, extractions: 1 },
      },
    });
    const data = envelope.data as MaterialIngestExactUrlExecutionData;
    expect(data).toMatchObject({
      executionMode: "exact_url_extraction",
      artifact: null,
      acquisition: {
        mode: "unavailable",
        status: "not_materialized",
        source: { kind: "url", url: sourceUrl },
        httpStatusCodes: [403],
      },
      extraction: {
        materialInputKind: "url",
        provider: { id: "mineru-extractor" },
        source: { kind: "url", url: sourceUrl },
        record: { backend: "mineru-extractor", source: { kind: "url", url: sourceUrl } },
        markdown: "# Recovered through MinerU\n",
      },
    });
    expect(data.outputs).not.toHaveProperty("artifactPath");
    expect(data.outputs).not.toHaveProperty("artifactRecordPath");
    await expect(stat(data.outputs.markdownPath)).resolves.toBeDefined();
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(path.join(project.workspaceRoot, "material", "artifacts"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      `https://r.jina.ai/${sourceUrl}`,
    );
  });

  it("uses verified Jina Reader Markdown only after the managed exact-URL extractor fails", async () => {
    const project = await createProject({
      prefix: "paper-search-material-jina-fallback-",
      extractor: "failing",
    });
    const sourceUrl = "https://example.test/papers/reader.pdf";
    const markdown = `Title: Reader result\nURL Source: ${sourceUrl}\n\n# Recovered through Jina Reader\n`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === sourceUrl) return new Response("unauthorized", { status: 401 });
      if (url === `https://r.jina.ai/${sourceUrl}`) {
        return new Response(markdown, { status: 200, headers: { "content-type": "text/markdown" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope).toMatchObject({
      ok: true,
      diagnostics: {
        acquisitionHttpStatusCodes: [401],
        sourceCounts: { artifacts: 0, extractions: 1 },
        fallbackAttempts: [
          { providerId: "failing-url-extractor", status: "failed" },
          { providerId: "jina-reader", status: "succeeded" },
        ],
      },
    });
    const data = envelope.data as MaterialIngestExactUrlExecutionData;
    expect(data).toMatchObject({
      executionMode: "exact_url_extraction",
      artifact: null,
      extraction: {
        provider: { id: "jina-reader", kind: "builtin" },
        source: { kind: "url", url: sourceUrl },
        record: { backend: "jina-reader", source: { kind: "url", url: sourceUrl } },
        markdown: markdown.trim(),
      },
    });
    await expect(stat(data.outputs.markdownPath)).resolves.toBeDefined();
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(path.join(project.workspaceRoot, "material", "artifacts"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "source identity mismatch",
      markdown: "Title: Wrong source\nURL Source: https://other.test/paper.pdf\n\n# Wrong\n",
    },
    {
      name: "challenge content",
      markdown: "Title: Just a moment\nURL Source: https://example.test/papers/challenged.pdf\n\nEnable JavaScript and cookies to continue\n",
    },
  ])("fails closed for Jina Reader $name", async ({ markdown }) => {
    const project = await createProject({
      prefix: "paper-search-material-jina-reject-",
      extractor: "failing",
    });
    const sourceUrl = "https://example.test/papers/challenged.pdf";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === sourceUrl) return new Response("forbidden", { status: 403 });
      if (url === `https://r.jina.ai/${sourceUrl}`) {
        return new Response(markdown, { status: 200, headers: { "content-type": "text/markdown" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope).toMatchObject({
      ok: false,
      data: null,
      diagnostics: { sourceCounts: { artifacts: 0, extractions: 0 } },
    });
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(project.extractionRoot);
    await expectMissingOrEmpty(path.join(project.workspaceRoot, "material"));
  });

  it("fails closed when managed extraction and Jina Reader both fail", async () => {
    const project = await createProject({
      prefix: "paper-search-material-all-fallbacks-fail-",
      extractor: "failing",
    });
    const sourceUrl = "https://example.test/papers/unavailable.pdf";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === sourceUrl) return new Response("rate limited", { status: 429 });
      if (url === `https://r.jina.ai/${sourceUrl}`) return new Response("unavailable", { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope).toMatchObject({
      ok: false,
      data: null,
      diagnostics: {
        acquisitionHttpStatusCodes: [429],
        sourceCounts: { artifacts: 0, extractions: 0 },
      },
    });
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(project.extractionRoot);
    await expectMissingOrEmpty(path.join(project.workspaceRoot, "material"));
  });

  it.each([
    { name: "non-eligible HTTP status", sourceUrl: "https://example.test/papers/server-error.pdf", status: 503 },
    { name: "unsafe non-HTTPS URL", sourceUrl: "http://example.test/papers/unsafe.pdf", status: null },
  ])("does not widen fallback behavior for a $name", async ({ sourceUrl, status }) => {
    const project = await createProject({
      prefix: "paper-search-material-no-fallback-",
      extractor: "failing",
    });
    const fetchMock = vi.fn(async () => new Response("not available", { status: status ?? 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runMaterialIngest(project.root, sourceUrl, project.extractorId);

    expect(envelope).toMatchObject({ ok: false, data: null });
    expect(fetchMock).toHaveBeenCalledTimes(status === null ? 0 : 1);
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(project.extractionRoot);
  });

  it("does not reinterpret a 403 from another potentially non-idempotent provider", async () => {
    const project = await createProject({
      prefix: "paper-search-material-non-idempotent-provider-",
      extractor: "failing",
    });
    await writeNonIdempotentDownloader(path.join(project.root, "providers"));
    const sourceUrl = "https://example.test/papers/non-idempotent.pdf";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const envelope = await runMaterialIngest(
      project.root,
      sourceUrl,
      project.extractorId,
      "non-idempotent-downloader",
    );

    expect(envelope).toMatchObject({ ok: false, data: null });
    expect(fetchMock).not.toHaveBeenCalled();
    await expectMissingOrEmpty(project.artifactRoot);
    await expectMissingOrEmpty(project.extractionRoot);
  });
});
