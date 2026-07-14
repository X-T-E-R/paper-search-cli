import { ExternalSearchError } from "./errors.js";
import {
  EXTERNAL_SEARCH_PROTOCOL,
  EXTERNAL_SEARCH_VERSION,
  ExternalSearchResponseSchema,
  type ExternalSearchRequest,
  type ExternalSearchResponse,
} from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseExternalSearchResponse(
  stdout: string,
  request: ExternalSearchRequest,
): ExternalSearchResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new ExternalSearchError("malformed_json", "External search stdout must contain exactly one JSON document", { cause: error });
  }
  const rawRecord = record(raw);
  if (rawRecord?.protocol !== EXTERNAL_SEARCH_PROTOCOL || rawRecord.version !== EXTERNAL_SEARCH_VERSION) {
    throw new ExternalSearchError(
      "protocol_incompatible",
      `External search protocol must be ${EXTERNAL_SEARCH_PROTOCOL} v${EXTERNAL_SEARCH_VERSION}`,
    );
  }
  if (rawRecord.requestId !== request.requestId) {
    throw new ExternalSearchError("request_id_mismatch", "External search response requestId did not match the request");
  }
  if (rawRecord.operation !== request.operation) {
    throw new ExternalSearchError("operation_mismatch", "External search response operation did not match the request");
  }
  const parsed = ExternalSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExternalSearchError(
      "protocol_schema_mismatch",
      `External search response failed v1 validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`,
      { cause: parsed.error },
    );
  }
  if (request.operation === "probe" && parsed.data.operation === "probe" && parsed.data.ok) {
    if (!parsed.data.data.protocolVersions.includes(EXTERNAL_SEARCH_VERSION)) {
      throw new ExternalSearchError("protocol_incompatible", "External search probe does not advertise protocol version 1");
    }
  }
  if (request.operation === "search" && parsed.data.operation === "search" && parsed.data.data) {
    if (parsed.data.data.query !== request.query) {
      throw new ExternalSearchError("protocol_schema_mismatch", "External search response query did not match the normalized request query");
    }
    if (parsed.data.data.results.length > request.maxResults) {
      throw new ExternalSearchError(
        "protocol_schema_mismatch",
        `External search returned ${parsed.data.data.results.length} results, exceeding maxResults ${request.maxResults}`,
      );
    }
  }
  return parsed.data;
}
