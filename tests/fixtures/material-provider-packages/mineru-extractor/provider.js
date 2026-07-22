var __material_provider_exports = {
  createProvider(runtimeContext) {
    const CONTRACT_VERSION = "paper-search.material-provider.mineru.v1";
    const DEFAULT_ENDPOINT = "https://mineru.net";
    const OFFICIAL_USER_AGENT = "openclaw-mineru";
    const DEFAULT_RESULT_ZIP_MAX_BYTES = 64 * 1024 * 1024;
    const DEFAULT_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
    const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|pptx?|png|jpe?g|tiff?|bmp|webp)(?:[?#].*)?$/i;

    function configValue(key, fallback) {
      if (!runtimeContext || !runtimeContext.config || typeof runtimeContext.config.get !== "function") {
        return fallback;
      }
      return runtimeContext.config.get(key, fallback);
    }

    function stringValue(value, fallback) {
      if (typeof value !== "string") return fallback;
      const trimmed = value.trim();
      return trimmed ? trimmed : fallback;
    }

    function booleanValue(value, fallback) {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
      }
      return fallback;
    }

    function numberValue(value, fallback) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return fallback;
    }

    function byteLimit(configKey, fallback) {
      const value = numberValue(configValue(configKey, fallback), fallback);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${configKey} must be a positive safe integer.`);
      }
      return value;
    }

    function apiBase() {
      return stringValue(configValue("endpoint", DEFAULT_ENDPOINT), DEFAULT_ENDPOINT).replace(/\/+$/, "");
    }

    function configuredToken() {
      const value = configValue("apiToken", "");
      if (typeof value !== "string") return "";
      return value.trim().replace(/^Bearer\s+/i, "");
    }

    function requireToken() {
      const token = configuredToken();
      if (!token) {
        throw new Error("Missing MinerU apiToken; set config apiToken or MINERU_TOKEN.");
      }
      return token;
    }

    function authHeader(redacted) {
      const token = configuredToken();
      if (!token) return "Bearer <missing>";
      return redacted ? "Bearer <redacted>" : `Bearer ${token}`;
    }

    function requestHeaders(redacted) {
      return {
        accept: "application/json",
        authorization: authHeader(redacted),
        "content-type": "application/json",
        "user-agent": OFFICIAL_USER_AGENT
      };
    }

    function inputOptions(input) {
      if (input && typeof input === "object" && input.options && typeof input.options === "object") {
        return input.options;
      }
      return {};
    }

    function inputOption(input, optionKey) {
      const options = inputOptions(input);
      if (Object.prototype.hasOwnProperty.call(options, optionKey)) return options[optionKey];
      return undefined;
    }

    function optionValue(input, optionKey, configKey, fallback) {
      const direct = inputOption(input, optionKey);
      if (direct !== undefined) return direct;
      return configValue(configKey, fallback);
    }

    function pickModelVersion(locator, configured, input) {
      const requested = stringValue(configured, "auto");
      if (requested !== "auto") return requested;
      const value = String(locator);
      if (DOCUMENT_EXTENSIONS.test(value)) return "pipeline";
      const artifact = input && typeof input === "object" && input.artifact && typeof input.artifact === "object"
        ? input.artifact
        : null;
      if (artifact) {
        const artifactKind = stringValue(artifact.kind, "").toLowerCase();
        const contentType = stringValue(artifact.contentType || artifact.mimeType, "").toLowerCase();
        const artifactLocator = artifact.filename || artifact.path || (artifact.storage && artifact.storage.key) || "";
        if (
          artifactKind === "pdf" ||
          contentType === "application/pdf" ||
          DOCUMENT_EXTENSIONS.test(String(artifactLocator))
        ) {
          return "pipeline";
        }
      }
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        if (
          (hostname === "arxiv.org" || hostname.endsWith(".arxiv.org")) &&
          /^\/pdf(?:\/|$)/i.test(parsed.pathname)
        ) {
          return "pipeline";
        }
      } catch {
        // Local paths and non-URL locators are handled by the extension check above.
      }
      return "MinerU-HTML";
    }

    function basename(filePath) {
      const parts = String(filePath).split(/[\\/]/);
      return parts[parts.length - 1] || "document";
    }

    function stableDataId(seed) {
      const bytes = new TextEncoder().encode(String(seed));
      let hash = 2166136261;
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
      }
      return `paper_search_${(hash >>> 0).toString(16)}`;
    }

    function stableJson(value) {
      if (value === undefined) return "null";
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(",")}}`;
    }

    function cacheEnabled(input) {
      const direct = inputOption(input, "cache");
      if (direct !== undefined) return booleanValue(direct, true);
      return booleanValue(configValue("cache", true), true);
    }

    function forceRequested(input) {
      return booleanValue(inputOption(input, "force"), false);
    }

    function extractionCachePath(request) {
      return `results/${stableDataId(
        stableJson({
          source: request.source,
          endpoint: request.endpoint,
          body: request.body,
          poll: request.poll
        })
      )}.json`;
    }

    function cachedExtractionResult(value) {
      if (!value || typeof value !== "object" || typeof value.markdown !== "string") {
        return null;
      }
      return {
        markdown: value.markdown,
        metadata: value.metadata || {},
        cacheHit: true,
        message:
          typeof value.message === "string"
            ? value.message
            : "MinerU extraction served from provider cache."
      };
    }

    function resolveSource(input) {
      if (!input || typeof input !== "object") {
        throw new Error("MinerU extraction input must be an object.");
      }
      const source = input.source;
      if (!source || typeof source !== "object") {
        throw new Error("MinerU extraction input must include source.");
      }

      if (source.kind === "url" && typeof source.url === "string" && source.url.trim()) {
        return { kind: "url", url: source.url.trim() };
      }

      if (source.kind === "path" && typeof source.path === "string" && source.path.trim()) {
        return { kind: "local_file", path: source.path.trim() };
      }

      if (source.kind === "artifact") {
        const artifact = input.artifact && typeof input.artifact === "object" ? input.artifact : {};
        if (typeof artifact.remoteUrl === "string" && artifact.remoteUrl.trim()) {
          return {
            kind: "artifact_url",
            url: artifact.remoteUrl.trim(),
            artifactId: source.artifactId || artifact.id
          };
        }
        if (typeof artifact.path === "string" && artifact.path.trim()) {
          return {
            kind: "artifact_file",
            path: artifact.path.trim(),
            artifactId: source.artifactId || artifact.id
          };
        }
        return {
          kind: "artifact_reference",
          artifactId: source.artifactId || artifact.id
        };
      }

      throw new Error(`Unsupported MinerU source kind: ${String(source.kind)}`);
    }

    function sharedMineruOptions(input, locator) {
      const language = stringValue(optionValue(input, "language", "language", "ch"), "ch");
      const pageRanges = stringValue(inputOption(input, "pageRanges"), "");
      const extraFormats = inputOption(input, "extraFormats");
      const body = {
        model_version: pickModelVersion(
          locator,
          optionValue(input, "modelVersion", "modelVersion", "auto"),
          input
        ),
        language,
        is_ocr: booleanValue(optionValue(input, "enableOcr", "enableOcr", false), false)
      };
      const enableTable = optionValue(input, "enableTable", "enableTable", undefined);
      const enableFormula = optionValue(input, "enableFormula", "enableFormula", undefined);
      if (enableTable !== undefined) body.enable_table = booleanValue(enableTable, false);
      if (enableFormula !== undefined) body.enable_formula = booleanValue(enableFormula, false);
      if (pageRanges) body.page_ranges = pageRanges;
      if (Array.isArray(extraFormats) && extraFormats.length > 0) {
        body.extra_formats = extraFormats.map(String);
      }
      return body;
    }

    function buildRequestInternal(input, redactedHeaders) {
      const source = resolveSource(input);

      if (source.kind === "url" || source.kind === "artifact_url") {
        const body = {
          url: source.url,
          ...sharedMineruOptions(input, source.url)
        };
        return {
          contractVersion: CONTRACT_VERSION,
          source,
          operation: "create-url-task",
          method: "POST",
          endpoint: `${apiBase()}/api/v4/extract/task`,
          headers: requestHeaders(redactedHeaders),
          body,
          poll: {
            operation: "poll-url-task",
            method: "GET",
            endpointTemplate: `${apiBase()}/api/v4/extract/task/{task_id}`
          },
          cache: {
            enabled: cacheEnabled(input),
            scope: "provider"
          }
        };
      }

      if (source.kind === "local_file" || source.kind === "artifact_file") {
        const body = sharedMineruOptions(input, source.path);
        const dataId = stableDataId(source.path);
        body.files = [{ name: basename(source.path), data_id: dataId }];
        return {
          contractVersion: CONTRACT_VERSION,
          source,
          operation: "create-upload-batch",
          method: "POST",
          endpoint: `${apiBase()}/api/v4/file-urls/batch`,
          headers: requestHeaders(redactedHeaders),
          body,
          upload: {
            method: "PUT",
            contentType: null,
            note: "Use MinerU signed file_urls without adding a Content-Type header."
          },
          poll: {
            operation: "poll-upload-batch",
            method: "GET",
            endpointTemplate: `${apiBase()}/api/v4/extract-results/batch/{batch_id}`
          },
          cache: {
            enabled: cacheEnabled(input),
            scope: "provider"
          }
        };
      }

      throw new Error("Artifact reference does not include a remoteUrl or local path for MinerU.");
    }

    function unwrapMineruResponse(response) {
      if (!response || typeof response !== "object") {
        throw new Error("MinerU response must be an object.");
      }
      if (Object.prototype.hasOwnProperty.call(response, "code") && response.code !== 0) {
        throw new Error(`MinerU API returned code ${String(response.code)}: ${String(response.msg || response.err_msg || "unknown error")}`);
      }
      return response.data && typeof response.data === "object" ? response.data : response;
    }

    function parseCreateTaskResponse(response) {
      const data = unwrapMineruResponse(response);
      const taskId = data.task_id || data.taskId;
      if (!taskId) {
        throw new Error("MinerU create task response is missing task_id.");
      }
      return {
        contractVersion: CONTRACT_VERSION,
        taskId: String(taskId),
        state: String(data.state || "submitted"),
        raw: data
      };
    }

    function parseUploadBatchResponse(response) {
      const data = unwrapMineruResponse(response);
      const batchId = data.batch_id || data.batchId;
      const fileUrls = Array.isArray(data.file_urls) ? data.file_urls : data.fileUrls;
      if (!batchId || !Array.isArray(fileUrls) || fileUrls.length === 0) {
        throw new Error("MinerU upload batch response is missing batch_id or file_urls.");
      }
      return {
        contractVersion: CONTRACT_VERSION,
        batchId: String(batchId),
        fileUrls: fileUrls.map(String),
        raw: data
      };
    }

    function parseTaskResult(response) {
      const data = unwrapMineruResponse(response);
      const extractResults = Array.isArray(data.extract_result) ? data.extract_result : undefined;
      const item = extractResults && extractResults.length > 0 ? extractResults[0] : data;
      const state = String(item.state || item.status || "unknown");
      if (state === "failed") {
        return {
          contractVersion: CONTRACT_VERSION,
          done: false,
          failed: true,
          state,
          message: String(item.err_msg || item.message || "MinerU task failed."),
          raw: item
        };
      }
      const fullZipUrl = item.full_zip_url || item.fullZipUrl || item.zip_url || item.zipUrl || null;
      const markdown = item.markdown || item.markdown_text || item.md || null;
      return {
        contractVersion: CONTRACT_VERSION,
        done: state === "done" || state === "completed" || Boolean(fullZipUrl || markdown),
        failed: false,
        state,
        taskId: item.task_id || item.taskId || null,
        batchId: item.batch_id || item.batchId || null,
        outputs: {
          markdown: typeof markdown === "string" ? markdown : null,
          fullZipUrl: typeof fullZipUrl === "string" ? fullZipUrl : null,
          json: item
        },
        message: item.err_msg || item.message || null,
        raw: item
      };
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function pollUrlTask(request, taskId) {
      const timeoutMs = numberValue(configValue("timeoutMs", 600000), 600000);
      const pollIntervalMs = Math.max(0, numberValue(configValue("pollIntervalMs", 3000), 3000));
      const deadline = Date.now() + timeoutMs;
      const pollUrl = request.poll.endpointTemplate.replace("{task_id}", encodeURIComponent(taskId));

      while (true) {
        const polled = await runtimeContext.http.get(pollUrl, {
          headers: request.headers,
          timeout: Math.min(timeoutMs, 60000)
        });
        const parsed = parseTaskResult(polled.data);
        if (parsed.failed) {
          const upstreamMessage = String(parsed.message || "MinerU extraction failed.")
            .replace(/^Error:\s*/i, "");
          throw new Error(
            `MinerU upstream task ${taskId} failed (state=${parsed.state}): ${upstreamMessage}`
          );
        }
        if (parsed.done) {
          return parsed;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`MinerU extraction timed out after ${timeoutMs}ms (${parsed.state})`);
        }
        if (pollIntervalMs > 0) {
          await sleep(Math.min(pollIntervalMs, remainingMs));
        }
      }
    }

    async function resolveResultMarkdown(parsed) {
      if (typeof parsed.outputs.markdown === "string" && parsed.outputs.markdown.length > 0) {
        return {
          markdown: parsed.outputs.markdown,
          retrieval: { mode: "inline", entryPath: null, entryCount: null, markdownBytes: null }
        };
      }
      if (!parsed.outputs.fullZipUrl) {
        throw new Error("MinerU completed without inline Markdown or full_zip_url.");
      }
      if (
        !runtimeContext.archive ||
        typeof runtimeContext.archive.readMarkdownFromZipBase64 !== "function"
      ) {
        throw new Error("MinerU result archive retrieval requires Paper Search CLI >= 0.5.0.");
      }
      const maxArchiveBytes = byteLimit("maxResultZipBytes", DEFAULT_RESULT_ZIP_MAX_BYTES);
      const maxMarkdownBytes = byteLimit("maxMarkdownBytes", DEFAULT_MARKDOWN_MAX_BYTES);
      const response = await runtimeContext.http.get(parsed.outputs.fullZipUrl, {
        headers: { "user-agent": OFFICIAL_USER_AGENT },
        responseType: "base64",
        maxResponseBytes: maxArchiveBytes,
        timeout: numberValue(configValue("timeoutMs", 600000), 600000)
      });
      if (typeof response.data !== "string") {
        throw new Error("MinerU result archive response was not Base64 text.");
      }
      const extracted = await runtimeContext.archive.readMarkdownFromZipBase64(response.data, {
        maxArchiveBytes,
        maxMarkdownBytes,
        preferredEntryNames: ["full.md"]
      });
      return {
        markdown: extracted.markdown,
        retrieval: {
          mode: "result-archive",
          entryPath: extracted.entryPath,
          entryCount: extracted.entryCount,
          markdownBytes: extracted.markdownBytes
        }
      };
    }

    function extractionResultFromParsed(input, parsed, resolved) {
      return {
        markdown: resolved.markdown,
        metadata: {
          mineru: parsed,
          request: buildRequestInternal(input, true),
          resultRetrieval: resolved.retrieval
        },
        cacheHit: false,
        message:
          resolved.retrieval.mode === "result-archive"
            ? `MinerU extraction completed from archive entry ${resolved.retrieval.entryPath}.`
            : "MinerU extraction completed with inline Markdown."
      };
    }

    async function extract(input) {
      requireToken();
      const request = buildRequestInternal(input, false);
      if (request.operation !== "create-url-task") {
        throw new Error("Live MinerU local-file upload requires host file upload support; inspect buildRequest() for the upload-batch contract.");
      }
      const useCache = cacheEnabled(input);
      const cachePath = extractionCachePath(buildRequestInternal(input, true));
      if (useCache && !forceRequested(input)) {
        const cached = cachedExtractionResult(await runtimeContext.cache.readJson(cachePath));
        if (cached) return cached;
      }
      const created = await runtimeContext.http.post(
        request.endpoint,
        request.body,
        {
          headers: request.headers,
          timeout: Math.min(numberValue(configValue("timeoutMs", 600000), 600000), 90000)
        }
      );
      const task = parseCreateTaskResponse(created.data);
      const parsed = await pollUrlTask(request, task.taskId);
      const resolved = await resolveResultMarkdown(parsed);
      const result = extractionResultFromParsed(input, parsed, resolved);
      if (useCache) {
        await runtimeContext.cache.writeJson(`tasks/${task.taskId}.json`, parsed);
        await runtimeContext.cache.writeJson(cachePath, result);
      }
      return result;
    }

    return {
      inspect() {
        return {
          contractVersion: CONTRACT_VERSION,
          id: "mineru-extractor",
          service: "MinerU official API",
          kind: "extractor",
          endpoint: apiBase(),
          network: true,
          inputs: ["url", "artifact"],
          liveInputs: ["url", "artifact"],
          wrapperContractInputs: ["url", "local_file", "artifact"],
          inputTypes: ["pdf", "html", "office", "image"],
          outputs: ["markdown", "json", "assets", "zip"],
          requiredConfig: ["apiToken"],
          optionalConfig: [
            "endpoint",
            "modelVersion",
            "language",
            "enableOcr",
            "enableTable",
            "enableFormula",
            "maxMarkdownBytes",
            "maxResultZipBytes",
            "pollIntervalMs",
            "timeoutMs",
            "cache"
          ],
          perCallOptions: [
            "cache",
            "force",
            "enableFormula",
            "enableOcr",
            "enableTable",
            "extraFormats",
            "language",
            "modelVersion",
            "pageRanges"
          ],
          cache: {
            configKey: "cache",
            perCallCacheOption: "cache",
            perCallForceOption: "force"
          },
          methods: [
            "inspect",
            "buildRequest",
            "parseCreateTaskResponse",
            "parseUploadBatchResponse",
            "parseTaskResult",
            "extract"
          ],
          flows: [
            {
              input: "url",
              create: "POST /api/v4/extract/task",
              poll: "GET /api/v4/extract/task/{task_id}"
            },
            {
              input: "local_file",
              create: "POST /api/v4/file-urls/batch",
              upload: "PUT signed file_urls without Content-Type",
              poll: "GET /api/v4/extract-results/batch/{batch_id}"
            }
          ],
          liveNetworkDuringInspect: false
        };
      },
      buildRequest(input) {
        return buildRequestInternal(input, true);
      },
      parseCreateTaskResponse,
      parseUploadBatchResponse,
      parseTaskResult,
      extract
    };
  }
};

globalThis.__material_provider_exports = __material_provider_exports;
