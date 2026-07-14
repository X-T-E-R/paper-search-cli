import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { digestJson, sha256Bytes, type JsonValue } from "./canonical.js";
import { assertExactAssessmentSubject, assertIdentityEvidence } from "./identity.js";
import { assertAssessmentPersistenceCanonical } from "./persistence.js";
import type { AssessmentSnapshotRef, LoadedAssessmentSnapshot } from "./types.js";
import { parseAssessmentSnapshot } from "./validation.js";

// The common run store caps result payloads at 4 MiB. Keep the source bounded
// so normalized evidence, conflicts, and policy trace can still be persisted.
const MAX_SNAPSHOT_BYTES = 1 * 1024 * 1024;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertIdentityCoverage(snapshot: LoadedAssessmentSnapshot["snapshot"]): void {
  for (const evidence of snapshot.identityEvidence) assertIdentityEvidence(evidence);
  const resolved = new Set(
    snapshot.identityEvidence
      .filter((evidence) => evidence.status === "found")
      .map((evidence) =>
        evidence.matchedSubject
          ? `${evidence.matchedSubject.kind}\u0000${evidence.matchedSubject.canonicalId}`
          : undefined,
      )
      .filter((id): id is string => id !== undefined),
  );
  for (const observation of snapshot.observations) {
    assertExactAssessmentSubject(observation.subject);
    if (!resolved.has(`${observation.subject.kind}\u0000${observation.subject.canonicalId}`)) {
      throw new Error(
        `Assessment observation ${observation.observationId} has no found identity evidence for ${observation.subject.canonicalId}`,
      );
    }
  }
}

export async function loadAssessmentSnapshot(ref: AssessmentSnapshotRef): Promise<LoadedAssessmentSnapshot> {
  if (!/^[a-f0-9]{64}$/iu.test(ref.sha256)) {
    throw new Error("Assessment snapshot reference requires a 64-character SHA-256 checksum");
  }
  const resolvedPath = path.resolve(ref.path);
  assertAssessmentPersistenceCanonical(resolvedPath, "Assessment snapshot path");
  const file = await lstat(resolvedPath);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`Assessment snapshot must be a regular non-symlink file: ${resolvedPath}`);
  }
  if (file.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Assessment snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes: ${resolvedPath}`);
  }
  const bytes = await readFile(resolvedPath);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== ref.sha256.toLowerCase()) {
    throw new Error(
      `Assessment snapshot checksum mismatch at ${resolvedPath}: expected ${ref.sha256.toLowerCase()}, got ${actualSha256}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid assessment snapshot at ${resolvedPath}: malformed JSON`, { cause: error });
  }
  const snapshot = parseAssessmentSnapshot(decoded);
  assertAssessmentPersistenceCanonical(snapshot as unknown as JsonValue, "Assessment snapshot");
  assertIdentityCoverage(snapshot);
  return deepFreeze({
    ref: { path: resolvedPath, sha256: actualSha256 },
    canonicalDigest: digestJson(snapshot as unknown as JsonValue),
    snapshot,
  });
}
