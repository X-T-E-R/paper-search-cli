export const INSTITUTIONAL_PROTOCOL_VERSION = 1 as const;
export const INSTSCI_ADAPTER_ID = "instsci-publisher-batch" as const;
export const INSTSCI_CAPTURE_REVISION = "836cd6b65ad74136b7a1ff17672816a3b8b789aa" as const;

export type InstitutionalOperation = "probe" | "acquire";
export type InstitutionalResponseStatus =
  | "ready"
  | "unavailable"
  | "acquired"
  | "action_required"
  | "not_entitled"
  | "unsupported"
  | "failed";

export interface InstitutionalRunnerRequest {
  protocolVersion: 1;
  requestId: string;
  operation: InstitutionalOperation;
  adapter: { id: typeof INSTSCI_ADAPTER_ID; revision: typeof INSTSCI_CAPTURE_REVISION };
  doi?: string;
  profileId?: string;
  handoffRoot?: string;
  maxPdfBytes?: number;
}

export interface InstitutionalRunnerResponse {
  protocolVersion: 1;
  requestId: string;
  adapter: { id: typeof INSTSCI_ADAPTER_ID; revision: typeof INSTSCI_CAPTURE_REVISION };
  status: InstitutionalResponseStatus;
  reasonCode?: string;
  message?: string;
  handoff?: { relativePath: string; sizeBytes: number; sha256: string };
}

export function assertInstitutionalRequest(request: InstitutionalRunnerRequest): void {
  const root = request as unknown as Record<string, unknown>;
  exactKeys(root, ["protocolVersion", "requestId", "operation", "adapter", "doi", "profileId", "handoffRoot", "maxPdfBytes"], "request");
  if (request.protocolVersion !== INSTITUTIONAL_PROTOCOL_VERSION) throw new Error("institutional request protocol version mismatch");
  string(request.requestId, "request.requestId");
  if (request.operation !== "probe" && request.operation !== "acquire") throw new Error("institutional request operation is invalid");
  if (request.adapter.id !== INSTSCI_ADAPTER_ID || request.adapter.revision !== INSTSCI_CAPTURE_REVISION) throw new Error("institutional request adapter mismatch");
  if (request.operation === "probe") {
    if (request.doi !== undefined || request.profileId !== undefined || request.handoffRoot !== undefined || request.maxPdfBytes !== undefined) {
      throw new Error("institutional probe request contains acquisition fields");
    }
    return;
  }
  if (typeof request.doi !== "string" || !/^10\.\d{4,9}\/[\S]+$/u.test(request.doi)) throw new Error("institutional acquire request DOI is invalid");
  if (typeof request.profileId !== "string" || !request.profileId) throw new Error("institutional acquire request profile id is invalid");
  if (typeof request.handoffRoot !== "string" || !request.handoffRoot) throw new Error("institutional acquire request handoff root is invalid");
  if (typeof request.maxPdfBytes !== "number" || !Number.isSafeInteger(request.maxPdfBytes) || request.maxPdfBytes < 1024) {
    throw new Error("institutional acquire request PDF limit is invalid");
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${field} contains unexpected fields: ${unexpected.join(", ")}`);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function parseInstitutionalResponse(
  value: unknown,
  request: InstitutionalRunnerRequest,
): InstitutionalRunnerResponse {
  const root = object(value, "response");
  exactKeys(root, ["protocolVersion", "requestId", "adapter", "status", "reasonCode", "message", "handoff"], "response");
  if (root.protocolVersion !== INSTITUTIONAL_PROTOCOL_VERSION) throw new Error("institutional protocol version mismatch");
  if (root.requestId !== request.requestId) throw new Error("institutional response request id mismatch");
  const adapter = object(root.adapter, "response.adapter");
  exactKeys(adapter, ["id", "revision"], "response.adapter");
  if (adapter.id !== INSTSCI_ADAPTER_ID || adapter.revision !== INSTSCI_CAPTURE_REVISION) {
    throw new Error("institutional adapter identity or revision mismatch");
  }
  const statuses: InstitutionalResponseStatus[] = ["ready", "unavailable", "acquired", "action_required", "not_entitled", "unsupported", "failed"];
  if (typeof root.status !== "string" || !statuses.includes(root.status as InstitutionalResponseStatus)) {
    throw new Error("institutional response status is invalid");
  }
  const response: InstitutionalRunnerResponse = {
    protocolVersion: 1,
    requestId: request.requestId,
    adapter: { id: INSTSCI_ADAPTER_ID, revision: INSTSCI_CAPTURE_REVISION },
    status: root.status as InstitutionalResponseStatus,
  };
  if (root.reasonCode !== undefined) {
    const reasonCode = string(root.reasonCode, "response.reasonCode");
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(reasonCode)) throw new Error("response.reasonCode is invalid");
    response.reasonCode = reasonCode;
  }
  if (root.message !== undefined) response.message = string(root.message, "response.message").slice(0, 500);
  if (root.handoff !== undefined) {
    const handoff = object(root.handoff, "response.handoff");
    exactKeys(handoff, ["relativePath", "sizeBytes", "sha256"], "response.handoff");
    const sizeBytes = handoff.sizeBytes;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw new Error("response.handoff.sizeBytes must be a positive safe integer");
    }
    const sha256 = string(handoff.sha256, "response.handoff.sha256").toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("response.handoff.sha256 must be SHA-256 hex");
    response.handoff = { relativePath: string(handoff.relativePath, "response.handoff.relativePath"), sizeBytes, sha256 };
  }
  if ((response.status === "acquired") !== Boolean(response.handoff)) {
    throw new Error("only an acquired response must contain a handoff");
  }
  return response;
}
