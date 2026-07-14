import { createHash } from "node:crypto";
import { tryAppendLifecycleEvent } from "../runtime/eventLedger.js";
import { withLocks } from "./locks.js";
import { canonicalizeRegistrySource, configuredUrlDigest, assertSubscriptionId } from "./source.js";
import {
  applySubscriptionTransaction,
  findDependentReceipts,
  identityChange,
  jsonContent,
  readIdentity,
  readSubscriptionsFile,
  readTombstones,
  recoverSubscriptionTransactions,
  subscriptionConfigChange,
  tombstonesChange,
} from "./store.js";
import { fetchAndValidateRegistry, writeRegistrySnapshot } from "./registry.js";
import type {
  RegistryRuntimeKind,
  RegistrySnapshotSummary,
  SubscriptionIntent,
  SubscriptionMutationPlan,
  SubscriptionTombstone,
  SubscriptionView,
} from "./types.js";

export interface MutationRequest {
  operation: SubscriptionMutationPlan["operation"];
  id: string;
  url?: string;
  runtimeKind?: RegistryRuntimeKind;
  orphanDependents?: boolean;
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function toView(
  id: string,
  intent: SubscriptionIntent,
  env: NodeJS.ProcessEnv,
): Promise<SubscriptionView> {
  const identity = await readIdentity(id, env);
  const status = !identity
    ? "identity-missing"
    : configuredUrlDigest(intent.url) !== identity.configuredUrlDigest
      ? "rebind-pending"
      : intent.enabled
        ? "active"
        : "disabled";
  return {
    id,
    ...intent,
    status,
    identity,
    dependents: await findDependentReceipts(id, identity?.sourceFingerprint ?? null, env),
  };
}

export async function listSubscriptions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionView[]> {
  const config = await readSubscriptionsFile(env);
  return Promise.all(
    Object.entries(config.subscriptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, intent]) => toView(id, intent, env)),
  );
}

export async function showSubscription(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionView> {
  assertSubscriptionId(id);
  const config = await readSubscriptionsFile(env);
  const intent = config.subscriptions[id];
  if (!intent) throw new Error(`Subscription not found: ${id}`);
  return toView(id, intent, env);
}

export async function planSubscriptionMutation(
  request: MutationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SubscriptionMutationPlan> {
  const id = assertSubscriptionId(request.id);
  const config = await readSubscriptionsFile(env);
  const before = config.subscriptions[id] ?? null;
  const identity = await readIdentity(id, env);
  let after: SubscriptionIntent | null = before ? { ...before } : null;
  let sourceFingerprint = identity?.sourceFingerprint ?? null;

  if (request.operation === "add") {
    if (before) throw new Error(`Subscription already exists: ${id}`);
    if (!request.url || !request.runtimeKind) throw new Error("add requires url and runtime kind");
    const source = await canonicalizeRegistrySource(request.url, request.runtimeKind);
    after = { runtimeKind: request.runtimeKind, url: request.url, enabled: true };
    sourceFingerprint = source.sourceFingerprint;
  } else {
    if (!before) throw new Error(`Subscription not found: ${id}`);
    if (request.operation === "rebind") {
      if (!request.url) throw new Error("rebind requires url");
      const source = await canonicalizeRegistrySource(request.url, before.runtimeKind);
      after = { ...before, url: request.url };
      sourceFingerprint = source.sourceFingerprint;
    } else if (request.operation === "enable") {
      if (!identity || configuredUrlDigest(before.url) !== identity.configuredUrlDigest) {
        throw new Error(`Subscription requires rebind before it can be enabled: ${id}`);
      }
      after = { ...before, enabled: true };
    } else if (request.operation === "disable") {
      after = { ...before, enabled: false };
    } else if (request.operation === "remove") {
      after = null;
    }
  }

  const originChanges = request.operation === "rebind" &&
    (!identity || sourceFingerprint !== identity.sourceFingerprint);
  const dependents = request.operation === "remove" || originChanges
    ? await findDependentReceipts(id, identity?.sourceFingerprint ?? null, env)
    : [];
  if (dependents.length > 0 && !identity) {
    throw new Error(
      `Subscription ${id} has dependent providers but its persisted identity is missing; the old origin cannot be tombstoned safely`,
    );
  }
  if (dependents.length > 0 && !request.orphanDependents) {
    throw new Error(
      `Subscription ${id} has dependent providers (${dependents.join(", ")}); rerun with --orphan-dependents`,
    );
  }
  const base = {
    schemaVersion: 1 as const,
    operation: request.operation,
    subscriptionId: id,
    before,
    after,
    sourceFingerprint,
    dependents,
    orphanDependents: Boolean(request.orphanDependents),
  };
  return { ...base, planDigest: hashPlan(base) };
}

export async function executeSubscriptionMutation(
  request: MutationRequest,
  apply: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  plan: SubscriptionMutationPlan;
  applied: boolean;
  operationId?: string;
  auditWarnings?: string[];
}> {
  const initialPlan = await planSubscriptionMutation(request, env);
  if (!apply) return { plan: initialPlan, applied: false };
  const id = initialPlan.subscriptionId;
  const result = await withLocks(
    ["subscriptions-file", `subscription/${id}`],
    async () => {
      await recoverSubscriptionTransactions(id, env);
      const plan = await planSubscriptionMutation(request, env);
      if (plan.planDigest !== initialPlan.planDigest) {
        throw new Error(`Subscription plan became stale: ${id}`);
      }
      const config = await readSubscriptionsFile(env);
      const oldIdentity = await readIdentity(id, env);
      const nextConfig = structuredClone(config);
      if (plan.after) nextConfig.subscriptions[id] = plan.after;
      else delete nextConfig.subscriptions[id];
      const changes = [subscriptionConfigChange(nextConfig, env)];

      let nextIdentity = oldIdentity;
      if (request.operation === "add" || request.operation === "rebind") {
        const intent = plan.after!;
        const source = await canonicalizeRegistrySource(intent.url, intent.runtimeKind);
        if (source.sourceFingerprint !== plan.sourceFingerprint) {
          throw new Error(`Subscription source changed while applying plan: ${id}`);
        }
        nextIdentity = request.operation === "rebind" &&
          oldIdentity?.sourceFingerprint === source.sourceFingerprint
          ? { ...oldIdentity, ...source }
          : {
              schemaVersion: 1,
              subscriptionId: id,
              runtimeKind: intent.runtimeKind,
              ...source,
              createdAt: new Date().toISOString(),
              latestRegistryDigest: null,
            };
      } else if (request.operation === "remove") {
        nextIdentity = null;
      }

      const rebindChangesOrigin = request.operation === "rebind" &&
        oldIdentity?.sourceFingerprint !== plan.sourceFingerprint;
      if ((request.operation === "remove" || rebindChangesOrigin) && oldIdentity) {
        const tombstones = await readTombstones(id, env);
        const tombstone: SubscriptionTombstone = {
          schemaVersion: 1,
          subscriptionId: id,
          removedAt: new Date().toISOString(),
          reason: request.operation === "remove" ? "remove" : "rebind",
          identity: oldIdentity,
          dependentIds: plan.dependents,
        };
        changes.push(tombstonesChange(id, [...tombstones, tombstone], env));
      }
      if (request.operation === "add" || request.operation === "rebind" || request.operation === "remove") {
        changes.push(identityChange(id, nextIdentity, env));
      }
      const operationId = await applySubscriptionTransaction({
        subscriptionId: id,
        command: `registries ${request.operation}`,
        planDigest: plan.planDigest,
        changes,
        env,
      });
      return { plan, applied: true, operationId };
    },
    { env, command: `registries ${request.operation}` },
  );
  const audit = await tryAppendLifecycleEvent({
    operationId: result.operationId,
    command: `registries ${request.operation}`,
    planDigest: result.plan.planDigest,
    affectedIds: [id],
    ...(result.plan.sourceFingerprint ? { sourceFingerprint: result.plan.sourceFingerprint } : {}),
    outcome: "applied",
  }, env);
  return {
    ...result,
    ...(audit.warning ? { auditWarnings: [audit.warning] } : {}),
  };
}

export async function refreshSubscriptions(
  id?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistrySnapshotSummary[]> {
  const views = id ? [await showSubscription(id, env)] : await listSubscriptions(env);
  const selected = views.filter((view) => {
    if (!view.enabled) return false;
    if (view.status === "rebind-pending") throw new Error(`Subscription requires rebind: ${view.id}`);
    if (!view.identity) throw new Error(`Subscription identity is missing: ${view.id}`);
    return true;
  });
  const fetched = await Promise.all(
    selected.map(async (view) => ({ view, fetched: await fetchAndValidateRegistry(view.identity!) })),
  );
  const summaries: RegistrySnapshotSummary[] = [];
  for (const item of fetched) {
    const expected = item.view.identity!;
    const summary = await withLocks(
      [`subscription/${item.view.id}`, `registry/${expected.sourceFingerprint}`],
      async () => {
        const currentConfig = await readSubscriptionsFile(env);
        const intent = currentConfig.subscriptions[item.view.id];
        const identity = await readIdentity(item.view.id, env);
        if (!intent?.enabled || !identity) throw new Error(`Subscription changed during refresh: ${item.view.id}`);
        if (
          configuredUrlDigest(intent.url) !== identity.configuredUrlDigest ||
          identity.sourceFingerprint !== expected.sourceFingerprint
        ) {
          throw new Error(`Subscription became rebind-pending during refresh: ${item.view.id}`);
        }
        const written = await writeRegistrySnapshot(item.view.id, identity, item.fetched, env);
        return written;
      },
      { env, command: "registries refresh" },
    );
    const audit = await tryAppendLifecycleEvent({
      command: "registries refresh",
      planDigest: hashPlan({
        subscriptionId: item.view.id,
        sourceFingerprint: summary.sourceFingerprint,
        registryDigest: summary.registryDigest,
      }),
      affectedIds: [item.view.id],
      sourceFingerprint: summary.sourceFingerprint,
      registryDigest: summary.registryDigest,
      outcome: "applied",
    }, env);
    summaries.push({
      ...summary,
      ...(audit.warning ? { auditWarnings: [audit.warning] } : {}),
    });
  }
  return summaries;
}
