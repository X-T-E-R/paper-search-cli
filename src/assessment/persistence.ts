import { redactForRunPersistence } from "../runs/redaction.js";
import { canonicalJson, type JsonValue } from "./canonical.js";

/** Fail rather than silently changing evidence after its checksum/digest is established. */
export function assertAssessmentPersistenceCanonical(value: JsonValue, label: string): void {
  const redacted = redactForRunPersistence(value);
  if (
    redacted === undefined ||
    canonicalJson(redacted as JsonValue) !== canonicalJson(value)
  ) {
    throw new Error(`${label} contains secret-like or non-canonical content that cannot enter a durable run`);
  }
}
