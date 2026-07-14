export type ExternalSearchErrorCode =
  | "external_search_disabled"
  | "external_search_misconfigured"
  | "adapter_invalid"
  | "tool_unavailable"
  | "process_spawn_failed"
  | "process_timeout"
  | "process_cancelled"
  | "process_output_limit"
  | "process_nonzero_exit"
  | "malformed_json"
  | "protocol_schema_mismatch"
  | "protocol_incompatible"
  | "request_id_mismatch"
  | "operation_mismatch";

export class ExternalSearchError extends Error {
  readonly code: ExternalSearchErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ExternalSearchErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ExternalSearchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function externalSearchError(error: unknown): ExternalSearchError {
  return error instanceof ExternalSearchError
    ? error
    : new ExternalSearchError(
        "external_search_misconfigured",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
}
