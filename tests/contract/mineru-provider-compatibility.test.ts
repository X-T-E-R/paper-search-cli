import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import {
  createMaterialRuntimeContext,
  type MaterialHttpRequestOptions,
  type MaterialHttpTransport,
} from "../../src/material/runtime/createContext.js";
import {
  invokeMaterialProviderFactoryInNode,
  type LoadedMaterialNodeProvider,
} from "../../src/material/runtime/invokeNodeFactory.js";

const packagesRoot = path.resolve("tests", "fixtures", "material-provider-packages");
const tmpRoot = path.resolve("tests", ".tmp", "mineru-provider-compatibility");

interface CapturedRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  options?: MaterialHttpRequestOptions;
}

interface CapturingTransport extends MaterialHttpTransport {
  requests: CapturedRequest[];
}

function createQueuedTransport(steps: {
  post?: unknown[];
  get?: unknown[];
}): CapturingTransport {
  const requests: CapturedRequest[] = [];
  const postQueue = [...(steps.post ?? [])];
  const getQueue = [...(steps.get ?? [])];
  return {
    requests,
    async get<T = unknown>(url: string, options?: MaterialHttpRequestOptions) {
      requests.push({ method: "GET", url, options });
      if (getQueue.length === 0) {
        throw new Error(`Unexpected MinerU GET in offline compatibility test: ${url}`);
      }
      return {
        data: getQueue.shift() as T,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      };
    },
    async post<T = unknown>(
      url: string,
      body?: string | Record<string, unknown>,
      options?: MaterialHttpRequestOptions,
    ) {
      requests.push({ method: "POST", url, body, options });
      if (postQueue.length === 0) {
        throw new Error(`Unexpected MinerU POST in offline compatibility test: ${url}`);
      }
      return {
        data: postQueue.shift() as T,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      };
    },
  };
}

function createBlockedTransport(): CapturingTransport {
  return createQueuedTransport({});
}

async function loadMineruRuntime(options?: {
  providerConfig?: Record<string, unknown>;
  transport?: CapturingTransport;
  cacheName?: string;
}): Promise<{
  runtime: LoadedMaterialNodeProvider;
  transport: CapturingTransport;
}> {
  const loaded = await loadMaterialProviderPackage(path.join(packagesRoot, "mineru-extractor"));
  const transport = options?.transport ?? createBlockedTransport();
  const cacheName = options?.cacheName ?? "default";
  const runtimeContext = createMaterialRuntimeContext({
    manifest: loaded.manifest,
    providerConfig: {
      apiToken: "fixture-token",
      endpoint: "https://mineru.net",
      pollIntervalMs: 0,
      timeoutMs: 5000,
      ...(options?.providerConfig ?? {}),
    },
    cacheRoot: path.join(tmpRoot, cacheName, "cache"),
    workspaceRoot: path.join(tmpRoot, cacheName, "workspace"),
    transport,
  });
  const runtime = await invokeMaterialProviderFactoryInNode(
    loaded.bundleCode,
    loaded.manifest,
    runtimeContext,
  );
  return { runtime, transport };
}

function providerMethod(runtime: LoadedMaterialNodeProvider, name: string) {
  const method = runtime.provider[name];
  if (!method) {
    throw new Error(`MinerU provider did not expose ${name}()`);
  }
  return method;
}

describe("MinerU provider compatibility", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  it("constructs URL task and local-file upload-batch requests without live network", async () => {
    const { runtime, transport } = await loadMineruRuntime({
      providerConfig: {
        language: "en",
        enableTable: true,
      },
    });
    const buildRequest = providerMethod(runtime, "buildRequest");

    const urlRequest = (await buildRequest({
      source: { kind: "url", url: "https://example.org/article.html" },
      options: {
        enableFormula: false,
        pageRanges: "3-5",
      },
    })) as {
      operation: string;
      method: string;
      endpoint: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
      poll: { method: string; endpointTemplate: string };
      cache: { enabled: boolean; scope: string };
    };

    expect(urlRequest).toMatchObject({
      operation: "create-url-task",
      method: "POST",
      endpoint: "https://mineru.net/api/v4/extract/task",
      headers: {
        accept: "application/json",
        authorization: "Bearer <redacted>",
        "content-type": "application/json",
      },
      body: {
        url: "https://example.org/article.html",
        model_version: "MinerU-HTML",
        language: "en",
        is_ocr: true,
        enable_table: true,
        enable_formula: false,
        page_ranges: "3-5",
      },
      poll: {
        method: "GET",
        endpointTemplate: "https://mineru.net/api/v4/extract/task/{task_id}",
      },
      cache: {
        enabled: true,
        scope: "provider",
      },
    });
    expect(urlRequest.headers.authorization).not.toContain("fixture-token");

    const cacheDisabledRequest = (await buildRequest({
      source: { kind: "url", url: "https://example.org/no-cache.html" },
      options: {
        cache: false,
      },
    })) as {
      cache: { enabled: boolean; scope: string };
    };
    expect(cacheDisabledRequest.cache).toEqual({
      enabled: false,
      scope: "provider",
    });

    const localFileRequest = (await buildRequest({
      source: { kind: "path", path: "downloads/mineru paper.pdf" },
      options: {
        enableOcr: false,
        extraFormats: ["json", "layout"],
      },
    })) as {
      operation: string;
      method: string;
      endpoint: string;
      headers: Record<string, string>;
      body: {
        files: Array<{ name: string; data_id: string }>;
        extra_formats: string[];
        is_ocr: boolean;
      };
      upload: { method: string; contentType: null; note: string };
      poll: { method: string; endpointTemplate: string };
    };

    const firstFile = localFileRequest.body.files[0];
    expect(localFileRequest).toMatchObject({
      operation: "create-upload-batch",
      method: "POST",
      endpoint: "https://mineru.net/api/v4/file-urls/batch",
      body: {
        files: [expect.objectContaining({ name: "mineru paper.pdf" })],
        extra_formats: ["json", "layout"],
        is_ocr: false,
      },
      upload: {
        method: "PUT",
        contentType: null,
        note: "Use MinerU signed file_urls without adding a Content-Type header.",
      },
      poll: {
        method: "GET",
        endpointTemplate: "https://mineru.net/api/v4/extract-results/batch/{batch_id}",
      },
    });
    expect(firstFile?.data_id).toMatch(/^paper_search_[a-f0-9]+$/);
    expect(localFileRequest.headers.authorization).toBe("Bearer <redacted>");
    expect(transport.requests).toEqual([]);
  });

  it("parses MinerU create, upload, and result success JSON contracts", async () => {
    const { runtime } = await loadMineruRuntime();
    const parseCreateTaskResponse = providerMethod(runtime, "parseCreateTaskResponse");
    const parseUploadBatchResponse = providerMethod(runtime, "parseUploadBatchResponse");
    const parseTaskResult = providerMethod(runtime, "parseTaskResult");

    await expect(
      parseCreateTaskResponse({
        code: 0,
        data: { task_id: "task_success", state: "submitted" },
      }),
    ).resolves.toMatchObject({
      contractVersion: "paper-search.material-provider.mineru.v1",
      taskId: "task_success",
      state: "submitted",
      raw: { task_id: "task_success" },
    });

    await expect(
      parseUploadBatchResponse({
        code: 0,
        data: {
          batch_id: "batch_success",
          file_urls: [
            "https://oss.aliyuncs.com/mineru/upload-1",
            "https://oss.aliyuncs.com/mineru/upload-2",
          ],
        },
      }),
    ).resolves.toMatchObject({
      contractVersion: "paper-search.material-provider.mineru.v1",
      batchId: "batch_success",
      fileUrls: [
        "https://oss.aliyuncs.com/mineru/upload-1",
        "https://oss.aliyuncs.com/mineru/upload-2",
      ],
    });

    await expect(
      parseTaskResult({
        code: 0,
        data: {
          task_id: "task_success",
          state: "done",
          markdown: "# URL result",
          full_zip_url: "https://oss.aliyuncs.com/mineru/task_success.zip",
        },
      }),
    ).resolves.toMatchObject({
      contractVersion: "paper-search.material-provider.mineru.v1",
      done: true,
      failed: false,
      state: "done",
      taskId: "task_success",
      outputs: {
        markdown: "# URL result",
        fullZipUrl: "https://oss.aliyuncs.com/mineru/task_success.zip",
        json: expect.objectContaining({ task_id: "task_success" }),
      },
    });

    await expect(
      parseTaskResult({
        code: 0,
        data: {
          batch_id: "batch_success",
          extract_result: [
            {
              batch_id: "batch_success",
              state: "completed",
              markdown_text: "# Batch result",
              zip_url: "https://oss.aliyuncs.com/mineru/batch_success.zip",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      done: true,
      failed: false,
      state: "completed",
      batchId: "batch_success",
      outputs: {
        markdown: "# Batch result",
        fullZipUrl: "https://oss.aliyuncs.com/mineru/batch_success.zip",
      },
    });
  });

  it("reports a missing token from extract before any network request", async () => {
    const { runtime, transport } = await loadMineruRuntime({
      providerConfig: {
        apiToken: "",
      },
    });
    const extract = providerMethod(runtime, "extract");

    await expect(
      extract({
        source: { kind: "url", url: "https://example.org/no-token.html" },
        options: {},
      }),
    ).rejects.toThrow(/Missing MinerU apiToken/);
    expect(transport.requests).toEqual([]);
  });

  it("maps MinerU API error codes and failed task states into deterministic failures", async () => {
    const transport = createQueuedTransport({
      post: [
        {
          code: 0,
          data: { task_id: "task_failed_state", state: "submitted" },
        },
      ],
      get: [
        {
          code: 0,
          data: {
            task_id: "task_failed_state",
            state: "failed",
            err_msg: "layout detection failed",
          },
        },
      ],
    });
    const { runtime } = await loadMineruRuntime({ transport });
    const parseCreateTaskResponse = providerMethod(runtime, "parseCreateTaskResponse");
    const parseTaskResult = providerMethod(runtime, "parseTaskResult");
    const extract = providerMethod(runtime, "extract");

    await expect(
      parseCreateTaskResponse({
        code: 1001,
        msg: "invalid token",
      }),
    ).rejects.toThrow(/MinerU API returned code 1001: invalid token/);

    await expect(
      parseTaskResult({
        code: 0,
        data: {
          task_id: "task_failed_state",
          state: "failed",
          err_msg: "layout detection failed",
        },
      }),
    ).resolves.toMatchObject({
      done: false,
      failed: true,
      state: "failed",
      message: "layout detection failed",
    });

    await expect(
      extract({
        source: { kind: "url", url: "https://example.org/fails.html" },
        options: {},
      }),
    ).rejects.toThrow(/layout detection failed/);
    expect(transport.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://mineru.net/api/v4/extract/task",
      }),
      expect.objectContaining({
        method: "GET",
        url: "https://mineru.net/api/v4/extract/task/task_failed_state",
      }),
    ]);
  });

  it("treats artifact inputs with a remoteUrl as live-compatible URL tasks", async () => {
    const transport = createQueuedTransport({
      post: [
        {
          code: 0,
          data: { task_id: "task_artifact_remote", state: "submitted" },
        },
      ],
      get: [
        {
          code: 0,
          data: {
            task_id: "task_artifact_remote",
            state: "done",
            markdown: "# Artifact-backed MinerU result",
            full_zip_url: "https://oss.aliyuncs.com/mineru/task_artifact_remote.zip",
          },
        },
      ],
    });
    const { runtime } = await loadMineruRuntime({ transport });
    const extract = providerMethod(runtime, "extract");

    await expect(
      extract({
        source: { kind: "artifact", artifactId: "artifact-123" },
        artifact: {
          id: "artifact-123",
          remoteUrl: "https://example.org/from-artifact.pdf",
          path: "material/files/artifact-123/from-artifact.pdf",
        },
        options: {},
      }),
    ).resolves.toMatchObject({
      markdown: "# Artifact-backed MinerU result",
      cacheHit: false,
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/task_artifact_remote.zip",
    });
    expect(transport.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://mineru.net/api/v4/extract/task",
      }),
      expect.objectContaining({
        method: "GET",
        url: "https://mineru.net/api/v4/extract/task/task_artifact_remote",
      }),
    ]);
  });

  it("serves cached extraction results and lets per-call force bypass the provider cache", async () => {
    const transport = createQueuedTransport({
      post: [
        {
          code: 0,
          data: { task_id: "task_cache_first", state: "submitted" },
        },
        {
          code: 0,
          data: { task_id: "task_cache_forced", state: "submitted" },
        },
      ],
      get: [
        {
          code: 0,
          data: {
            task_id: "task_cache_first",
            state: "done",
            markdown: "# First MinerU result",
            full_zip_url: "https://oss.aliyuncs.com/mineru/cache-first.zip",
          },
        },
        {
          code: 0,
          data: {
            task_id: "task_cache_forced",
            state: "done",
            markdown: "# Forced MinerU result",
            full_zip_url: "https://oss.aliyuncs.com/mineru/cache-forced.zip",
          },
        },
      ],
    });
    const { runtime } = await loadMineruRuntime({
      transport,
      cacheName: "cache-force",
    });
    const extract = providerMethod(runtime, "extract");
    const input = {
      source: { kind: "url", url: "https://example.org/cache-me.html" },
      options: {},
    };

    await expect(extract(input)).resolves.toMatchObject({
      markdown: "# First MinerU result",
      cacheHit: false,
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/cache-first.zip",
    });
    expect(transport.requests).toHaveLength(2);

    await expect(extract(input)).resolves.toMatchObject({
      markdown: "# First MinerU result",
      cacheHit: true,
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/cache-first.zip",
    });
    expect(transport.requests).toHaveLength(2);

    await expect(
      extract({
        ...input,
        options: { force: true },
      }),
    ).resolves.toMatchObject({
      markdown: "# Forced MinerU result",
      cacheHit: false,
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/cache-forced.zip",
    });
    expect(transport.requests).toHaveLength(4);

    await expect(extract(input)).resolves.toMatchObject({
      markdown: "# Forced MinerU result",
      cacheHit: true,
      message: "MinerU result zip: https://oss.aliyuncs.com/mineru/cache-forced.zip",
    });
    expect(transport.requests).toHaveLength(4);
  });
});
