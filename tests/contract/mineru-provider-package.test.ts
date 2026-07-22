import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import {
  createMaterialRuntimeContext,
  type MaterialHttpRequestOptions,
  type MaterialHttpTransport,
} from "../../src/material/runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "../../src/material/runtime/invokeNodeFactory.js";

const packagesRoot = path.resolve("tests", "fixtures", "material-provider-packages");
const tmpRoot = path.resolve("tests", ".tmp", "mineru-provider-package");

function createBlockedTransport(): MaterialHttpTransport & {
  requests: Array<{ method: "GET" | "POST"; url: string; body?: unknown }>;
} {
  const requests: Array<{ method: "GET" | "POST"; url: string; body?: unknown }> = [];
  return {
    requests,
    async get<T = unknown>(url: string) {
      requests.push({ method: "GET", url });
      throw new Error("MinerU provider contract tests must not make live GET requests");
    },
    async post<T = unknown>(url: string, body?: string | Record<string, unknown>) {
      requests.push({ method: "POST", url, body });
      throw new Error("MinerU provider contract tests must not make live POST requests");
    },
  };
}

function createQueuedTransport(steps: {
  post?: Array<unknown>;
  get?: Array<unknown>;
}): MaterialHttpTransport & {
  requests: Array<{
    method: "GET" | "POST";
    url: string;
    body?: unknown;
    options?: MaterialHttpRequestOptions;
  }>;
} {
  const requests: Array<{
    method: "GET" | "POST";
    url: string;
    body?: unknown;
    options?: MaterialHttpRequestOptions;
  }> = [];
  const postQueue = [...(steps.post ?? [])];
  const getQueue = [...(steps.get ?? [])];
  return {
    requests,
    async get<T = unknown>(url: string, options?: MaterialHttpRequestOptions) {
      requests.push({ method: "GET", url, options });
      if (getQueue.length === 0) {
        throw new Error(`Unexpected GET request in test transport: ${url}`);
      }
      return {
        data: getQueue.shift() as T,
        status: 200,
        statusText: "OK",
        headers: {},
      };
    },
    async post<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: MaterialHttpRequestOptions,
    ) {
      requests.push({ method: "POST", url, body, options });
      if (postQueue.length === 0) {
        throw new Error(`Unexpected POST request in test transport: ${url}`);
      }
      return {
        data: postQueue.shift() as T,
        status: 200,
        statusText: "OK",
        headers: {},
      };
    },
  };
}

describe("MinerU material provider package", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads through the material package loader with manifest, config, permissions, and capabilities", async () => {
    const mineruPackagePath = path.join(packagesRoot, "mineru-extractor");
    const loaded = await loadMaterialProviderPackage(mineruPackagePath);

    expect(loaded.packagePath).toBe(mineruPackagePath);
    expect(loaded.manifestPath).toBe(path.join(mineruPackagePath, "manifest.json"));
    expect(loaded.entrypointPath).toBe(path.join(mineruPackagePath, "provider.js"));
    expect(loaded.manifest).toMatchObject({
      id: "mineru-extractor",
      kind: "extractor",
      entry: "provider.js",
      capabilities: {
        inputs: ["url", "artifact"],
        inputTypes: ["pdf", "html", "office", "image"],
        outputs: ["markdown", "json", "assets", "zip"],
        network: true,
      },
      permissions: {
        network: [
          "https://mineru.net/api/v4/*",
          "https://*.mineru.net/api/v4/*",
          "https://cdn-mineru.openxlab.org.cn/*",
          "https://*.aliyuncs.com/*",
        ],
        localRead: true,
        localWrite: "cache",
      },
      rateLimit: {
        requestsPerMinute: 30,
      },
    });
    expect(loaded.manifest.configSchema).toMatchObject({
      apiToken: {
        type: "secret",
        required: true,
        env: ["MINERU_TOKEN", "MINERU_API_TOKEN"],
      },
      endpoint: {
        type: "string",
        default: "https://mineru.net",
      },
      modelVersion: {
        type: "string",
        default: "auto",
      },
      language: {
        type: "string",
        default: "ch",
      },
      enableOcr: {
        type: "boolean",
        default: false,
      },
      maxResultZipBytes: {
        type: "number",
        default: 67108864,
      },
      maxMarkdownBytes: {
        type: "number",
        default: 16777216,
      },
      pollIntervalMs: {
        type: "number",
        default: 3000,
      },
      timeoutMs: {
        type: "number",
        default: 600000,
      },
    });
    expect(loaded.bundleCode).toContain("__material_provider_exports");
    expect(loaded.bundleCode).toContain("buildRequest");
    expect(loaded.bundleCode).toContain("parseTaskResult");
  });

  it("exposes an inspectable MinerU wrapper contract without live network calls", async () => {
    const mineruPackagePath = path.join(packagesRoot, "mineru-extractor");
    const loaded = await loadMaterialProviderPackage(mineruPackagePath);
    const transport = createBlockedTransport();
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: {
        apiToken: "fixture-token",
        endpoint: "https://mineru.net",
        language: "en",
        modelVersion: "auto",
        enableOcr: true,
        enableTable: true,
        pageRanges: "9-10",
        extraFormats: ["json"],
      },
      cacheRoot: path.join(tmpRoot, "polling-cache"),
      workspaceRoot: path.join(tmpRoot, "polling-workspace"),
      transport,
    });

    const runtime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );

    expect(runtime.inspection.methods).toEqual([
      "inspect",
      "buildRequest",
      "parseCreateTaskResponse",
      "parseUploadBatchResponse",
      "parseTaskResult",
      "extract",
    ]);

    const inspect = runtime.provider.inspect;
    const buildRequest = runtime.provider.buildRequest;
    const parseCreateTaskResponse = runtime.provider.parseCreateTaskResponse;
    const parseUploadBatchResponse = runtime.provider.parseUploadBatchResponse;
    const parseTaskResult = runtime.provider.parseTaskResult;
    if (
      !inspect ||
      !buildRequest ||
      !parseCreateTaskResponse ||
      !parseUploadBatchResponse ||
      !parseTaskResult
    ) {
      throw new Error("MinerU provider did not expose the expected wrapper methods");
    }

    const inspection = (await inspect()) as {
      id: string;
      service: string;
      contractVersion: string;
      requiredConfig: string[];
      inputs: string[];
      liveInputs: string[];
      wrapperContractInputs: string[];
      outputs: string[];
      flows: Array<Record<string, string>>;
      liveNetworkDuringInspect: boolean;
    };
    expect(inspection).toMatchObject({
      id: "mineru-extractor",
      service: "MinerU official API",
      contractVersion: "paper-search.material-provider.mineru.v1",
      requiredConfig: ["apiToken"],
      inputs: ["url", "artifact"],
      liveInputs: ["url", "artifact"],
      wrapperContractInputs: ["url", "local_file", "artifact"],
      outputs: ["markdown", "json", "assets", "zip"],
      liveNetworkDuringInspect: false,
    });
    expect(inspection.flows).toEqual([
      expect.objectContaining({
        input: "url",
        create: "POST /api/v4/extract/task",
        poll: "GET /api/v4/extract/task/{task_id}",
      }),
      expect.objectContaining({
        input: "local_file",
        create: "POST /api/v4/file-urls/batch",
        upload: "PUT signed file_urls without Content-Type",
        poll: "GET /api/v4/extract-results/batch/{batch_id}",
      }),
    ]);

    const urlRequest = (await buildRequest({
      source: { kind: "url", url: "https://example.org/article.html" },
      options: {
        enableFormula: false,
        pageRanges: "1-2",
      },
    })) as {
      operation: string;
      method: string;
      endpoint: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      poll: { endpointTemplate: string };
    };
    expect(urlRequest).toMatchObject({
      operation: "create-url-task",
      method: "POST",
      endpoint: "https://mineru.net/api/v4/extract/task",
      headers: {
        authorization: "Bearer <redacted>",
      },
      body: {
        url: "https://example.org/article.html",
        model_version: "MinerU-HTML",
        language: "en",
        is_ocr: true,
        enable_table: true,
        enable_formula: false,
        page_ranges: "1-2",
      },
      poll: {
        endpointTemplate: "https://mineru.net/api/v4/extract/task/{task_id}",
      },
    });

    const requestWithoutPerCallRange = (await buildRequest({
      source: { kind: "url", url: "https://example.org/no-range.html" },
      options: {},
    })) as {
      body: Record<string, unknown>;
    };
    expect(requestWithoutPerCallRange.body).not.toHaveProperty("page_ranges");
    expect(requestWithoutPerCallRange.body).not.toHaveProperty("extra_formats");

    const localFileRequest = (await buildRequest({
      source: { kind: "path", path: "downloads/paper.pdf" },
      options: {
        extraFormats: ["layout", "json"],
      },
    })) as {
      operation: string;
      endpoint: string;
      body: {
        files: Array<{ name: string; data_id: string }>;
        extra_formats: string[];
      };
      upload: { method: string; note: string };
      poll: { endpointTemplate: string };
    };
    expect(localFileRequest).toMatchObject({
      operation: "create-upload-batch",
      endpoint: "https://mineru.net/api/v4/file-urls/batch",
      body: {
        files: [expect.objectContaining({ name: "paper.pdf" })],
        extra_formats: ["layout", "json"],
      },
      upload: {
        method: "PUT",
        note: "Use MinerU signed file_urls without adding a Content-Type header.",
      },
      poll: {
        endpointTemplate: "https://mineru.net/api/v4/extract-results/batch/{batch_id}",
      },
    });
    expect(localFileRequest.body.files[0]?.data_id).toMatch(/^paper_search_[a-f0-9]+$/);

    const createParsed = (await parseCreateTaskResponse({
      code: 0,
      data: { task_id: "task_fixture", state: "submitted" },
    })) as { taskId: string; state: string };
    expect(createParsed).toEqual(
      expect.objectContaining({
        taskId: "task_fixture",
        state: "submitted",
      }),
    );

    const uploadParsed = (await parseUploadBatchResponse({
      code: 0,
      data: {
        batch_id: "batch_fixture",
        file_urls: ["https://oss.aliyuncs.com/upload-1"],
      },
    })) as { batchId: string; fileUrls: string[] };
    expect(uploadParsed).toEqual(
      expect.objectContaining({
        batchId: "batch_fixture",
        fileUrls: ["https://oss.aliyuncs.com/upload-1"],
      }),
    );

    const resultParsed = (await parseTaskResult({
      code: 0,
      data: {
        task_id: "task_fixture",
        state: "done",
        full_zip_url: "https://oss.aliyuncs.com/mineru/task_fixture.zip",
        markdown: "# Extracted by MinerU",
      },
    })) as {
      done: boolean;
      failed: boolean;
      outputs: {
        markdown: string | null;
        fullZipUrl: string | null;
      };
    };
    expect(resultParsed).toEqual(
      expect.objectContaining({
        done: true,
        failed: false,
        outputs: {
          markdown: "# Extracted by MinerU",
          fullZipUrl: "https://oss.aliyuncs.com/mineru/task_fixture.zip",
          json: expect.objectContaining({
            task_id: "task_fixture",
            state: "done",
          }),
        },
      }),
    );
    expect(transport.requests).toEqual([]);
  });

  it("polls the URL task until completion using offline transport responses", async () => {
    const signedUrlSentinel = "MINERU_SIGNED_URL_SENTINEL";
    const mineruPackagePath = path.join(packagesRoot, "mineru-extractor");
    const loaded = await loadMaterialProviderPackage(mineruPackagePath);
    const transport = createQueuedTransport({
      post: [
        {
          code: 0,
          data: { task_id: "task_polling", state: "submitted" },
        },
      ],
      get: [
        {
          code: 0,
          data: { task_id: "task_polling", state: "processing" },
        },
        {
          code: 0,
          data: {
            task_id: "task_polling",
            state: "done",
            markdown: "# Polled MinerU Markdown",
            full_zip_url:
              `https://oss.aliyuncs.com/mineru/task_polling.zip?signature=${signedUrlSentinel}#${signedUrlSentinel}`,
          },
        },
      ],
    });
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: {
        apiToken: "fixture-token",
        endpoint: "https://mineru.net",
        pollIntervalMs: 0,
        timeoutMs: 5000,
      },
      cacheRoot: path.join(tmpRoot, "polling-cache"),
      workspaceRoot: path.join(tmpRoot, "polling-workspace"),
      transport,
    });

    const runtime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );
    const extract = runtime.provider.extract;
    if (!extract) {
      throw new Error("MinerU provider did not expose extract()");
    }

    const result = (await extract({
      source: { kind: "url", url: "https://example.org/poll-me.html" },
      options: {},
    })) as {
      markdown: string;
      cacheHit: boolean;
      message: string;
      metadata: {
        mineru: {
          done: boolean;
          outputs: { fullZipUrl: string | null };
        };
      };
    };

    expect(result).toMatchObject({
      markdown: "# Polled MinerU Markdown",
      cacheHit: false,
      message: "MinerU extraction completed with inline Markdown.",
      metadata: {
        mineru: {
          done: true,
          outputs: {
            fullZipUrl:
              `https://oss.aliyuncs.com/mineru/task_polling.zip?signature=${signedUrlSentinel}#${signedUrlSentinel}`,
          },
        },
      },
    });
    expect(transport.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://mineru.net/api/v4/extract/task",
      }),
      expect.objectContaining({
        method: "GET",
        url: "https://mineru.net/api/v4/extract/task/task_polling",
      }),
      expect.objectContaining({
        method: "GET",
        url: "https://mineru.net/api/v4/extract/task/task_polling",
      }),
    ]);
    const persistedTask = await readFile(
      path.join(
        tmpRoot,
        "polling-cache",
        "mineru-extractor",
        "tasks",
        "task_polling.json",
      ),
      "utf8",
    );
    expect(persistedTask).not.toContain(signedUrlSentinel);
    expect(persistedTask).toContain("signature");
  });

  it("bridges a manifest-declared process secret into MinerU without exposing it", async () => {
    const sentinel = "process-only-mineru-sentinel";
    vi.stubEnv("MINERU_TOKEN", sentinel);
    vi.stubEnv("UNDECLARED_PROVIDER_SECRET", "must-not-cross");
    const mineruPackagePath = path.join(packagesRoot, "mineru-extractor");
    const loaded = await loadMaterialProviderPackage(mineruPackagePath);
    const transport = createQueuedTransport({
      post: [{ code: 1001, msg: "invalid token" }],
    });
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: {
        endpoint: "https://mineru.net",
        pollIntervalMs: 0,
        timeoutMs: 5000,
      },
      cacheRoot: path.join(tmpRoot, "environment-secret-cache"),
      workspaceRoot: path.join(tmpRoot, "environment-secret-workspace"),
      transport,
    });
    const runtime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );
    const extract = runtime.provider.extract;
    if (!extract) throw new Error("MinerU provider did not expose extract()");

    let failure: unknown;
    try {
      await extract({
        source: { kind: "url", url: "https://example.org/environment-secret.pdf" },
        options: {},
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("MinerU API returned code 1001: invalid token");
    expect(message).not.toContain(sentinel);
    expect(runtimeContext.config.getRedacted("apiToken")).toBe("<redacted>");
    expect(runtimeContext.config.get("UNDECLARED_PROVIDER_SECRET")).toBeUndefined();
    expect(JSON.stringify(runtimeContext.config.getRedacted())).not.toContain(sentinel);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.options?.headers?.authorization).toBe(`Bearer ${sentinel}`);
  });

  it("reports the upstream MinerU task id, state, and message when parsing fails", async () => {
    const mineruPackagePath = path.join(packagesRoot, "mineru-extractor");
    const loaded = await loadMaterialProviderPackage(mineruPackagePath);
    const transport = createQueuedTransport({
      post: [
        {
          code: 0,
          data: { task_id: "task_parse_failed", state: "submitted" },
        },
      ],
      get: [
        {
          code: 0,
          data: {
            task_id: "task_parse_failed",
            state: "failed",
            err_msg: "Error: parsing failed, please try again later",
          },
        },
      ],
    });
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: {
        apiToken: "fixture-token",
        endpoint: "https://mineru.net",
        pollIntervalMs: 0,
        timeoutMs: 5000,
      },
      cacheRoot: path.join(tmpRoot, "failed-cache"),
      workspaceRoot: path.join(tmpRoot, "failed-workspace"),
      transport,
    });
    const runtime = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );
    const extract = runtime.provider.extract;
    if (!extract) throw new Error("MinerU provider did not expose extract()");

    await expect(extract({
      source: { kind: "url", url: "https://example.org/parse-failure.pdf" },
      options: {},
    })).rejects.toThrow(
      "extract() failed (mineru-extractor): MinerU upstream task task_parse_failed failed " +
      "(state=failed): parsing failed, please try again later",
    );
  });
});
