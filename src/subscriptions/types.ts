export type RegistryRuntimeKind = "search" | "material";

export interface SubscriptionIntent {
  runtimeKind: RegistryRuntimeKind;
  url: string;
  enabled: boolean;
}

export interface CanonicalRegistrySource {
  sourceType: "https" | "local";
  canonicalSource: string;
  sourceFingerprint: string;
  configuredUrlDigest: string;
}

export interface SubscriptionIdentity extends CanonicalRegistrySource {
  schemaVersion: 1;
  subscriptionId: string;
  runtimeKind: RegistryRuntimeKind;
  createdAt: string;
  latestRegistryDigest: string | null;
}

export interface SubscriptionTombstone {
  schemaVersion: 1;
  subscriptionId: string;
  removedAt: string;
  reason: "remove" | "rebind";
  identity: SubscriptionIdentity;
  dependentIds: string[];
}

export type SubscriptionStatus =
  | "active"
  | "disabled"
  | "rebind-pending"
  | "identity-missing";

export interface SubscriptionView {
  id: string;
  runtimeKind: RegistryRuntimeKind;
  url: string;
  enabled: boolean;
  status: SubscriptionStatus;
  identity: SubscriptionIdentity | null;
  dependents: string[];
}

export interface RegistryCandidateSummary {
  id: string;
  version: string;
  /** Publisher-declared provider subtype when the registry exposes it. */
  providerKind?: string;
  /** Sanitized archive reference as declared by the registry. */
  archiveRef?: string;
  archiveSha256: string | null;
  status: "available" | "blocked";
  blockedReason?: "missing-integrity" | "missing-archive";
  minRequiredVersion?: string;
}

export interface RegistrySnapshotSummary {
  schemaVersion: 1;
  subscriptionId: string;
  runtimeKind: RegistryRuntimeKind;
  sourceFingerprint: string;
  registryDigest: string;
  resolvedSource: string;
  fetchedAt: string;
  candidates: RegistryCandidateSummary[];
  auditWarnings?: string[];
}

export interface LoadedRegistrySnapshot {
  summary: RegistrySnapshotSummary;
  raw: string;
  candidates: RegistryCandidateSummary[];
}

export interface SubscriptionMutationPlan {
  schemaVersion: 1;
  operation: "add" | "rebind" | "enable" | "disable" | "remove";
  subscriptionId: string;
  before: SubscriptionIntent | null;
  after: SubscriptionIntent | null;
  sourceFingerprint: string | null;
  dependents: string[];
  orphanDependents: boolean;
  planDigest: string;
}
