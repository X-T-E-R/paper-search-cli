import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/assessment/index.js";
import { createDefaultConfig } from "../../src/config/defaults.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { runCanonicalTool } from "../../src/surface/toolRunner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function configFor(root: string): ResolvedConfig {
  const base = createDefaultConfig({
    HOME: root,
    USERPROFILE: root,
    PAPER_SEARCH_HOME: path.join(root, ".paper-search"),
  });
  return {
    ...base,
    meta: {
      cwd: root,
      userConfigPath: path.join(root, ".paper-search", "config.toml"),
      projectConfigPath: null,
      explicitConfigPath: null,
      loadedFiles: [],
      appliedEnvOverrides: [],
    },
  };
}

async function assessmentSnapshot(root: string): Promise<{ path: string; sha256: string }> {
  const observedAt = "2026-07-15T00:00:00.000Z";
  const source = {
    providerId: "fixture-snapshot",
    providerVersion: "1.0.0",
    sourceKind: "user-snapshot",
  };
  const subject = {
    kind: "work",
    canonicalId: "doi:10.1000/surface",
    identifiers: { doi: "10.1000/surface" },
  };
  const snapshot = {
    schemaVersion: 1,
    snapshotId: "surface-fixture",
    createdAt: observedAt,
    source,
    identityEvidence: [{
      evidenceId: "identity-1",
      status: "found",
      inputIdentifiers: subject.identifiers,
      matchedSubject: subject,
      matchedIdentifiers: subject.identifiers,
      matchMethod: "exact_identifier",
      observedAt,
      source,
    }],
    observations: [{
      observationId: "count-1",
      subject,
      signal: { kind: "citation_count", metricDefinition: "fixture citation count" },
      status: "found",
      value: 7,
      observedAt,
      source,
    }],
  };
  const bytes = JSON.stringify(snapshot, null, 2);
  const filePath = path.join(root, "assessment-snapshot.json");
  await writeFile(filePath, bytes, "utf8");
  return { path: filePath, sha256: sha256Bytes(bytes) };
}

describe("Paper Search CLI X canonical workflow surfaces", () => {
  it("wraps allowlisted discovery once and exposes read-only run management", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-x-run-surface-"));
    tempDirs.push(root);
    const config = configFor(root);

    const wrapped = await runCanonicalTool(config, "research_run", {
      tool: "academic_search",
      arguments: { query: "durable surface", sources: ["not-installed"] },
    });
    expect(wrapped).toMatchObject({
      ok: false,
      tool: "research_run",
      diagnostics: {
        wrappedTool: "academic_search",
        runId: expect.any(String),
      },
    });

    const runId = String(wrapped.diagnostics?.runId);
    const listed = await runCanonicalTool(config, "run_list", { kind: "tool" });
    expect(listed).toMatchObject({
      ok: true,
      tool: "run_list",
      data: { count: 1, runs: [{ runId, kind: "tool", status: "failed" }] },
    });
    const shown = await runCanonicalTool(config, "run_show", { runId });
    expect(shown).toMatchObject({
      ok: true,
      data: { run: { runId, request: { tool: "academic_search" } } },
    });
    const prune = await runCanonicalTool(config, "run_prune_plan", {});
    expect(prune).toMatchObject({ ok: true, tool: "run_prune_plan", planned: true });
  });

  it("keeps assessment plan write-free and replays a persisted report offline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-x-assess-surface-"));
    tempDirs.push(root);
    const config = configFor(root);
    const snapshot = await assessmentSnapshot(root);

    const planned = await runCanonicalTool(config, "assessment_run", {
      mode: "plan",
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
    });
    expect(planned).toMatchObject({
      ok: true,
      tool: "assessment_run",
      planned: true,
      data: { planned: true, runId: null, report: { evaluation: null } },
    });

    const executed = await runCanonicalTool(config, "assessment_run", {
      mode: "run",
      snapshotPath: snapshot.path,
      snapshotSha256: snapshot.sha256,
    });
    expect(executed).toMatchObject({
      ok: true,
      tool: "assessment_run",
      planned: false,
      data: { runId: expect.any(String), report: { resultDigest: expect.any(String) } },
    });
    const runId = String((executed.data as { runId: string }).runId);

    const replayed = await runCanonicalTool(config, "assessment_show", { runId });
    expect(replayed).toMatchObject({
      ok: true,
      tool: "assessment_show",
      data: { runId, report: { resultDigest: (executed.data as any).report.resultDigest } },
    });
    const listed = await runCanonicalTool(config, "assessment_list", {});
    expect(listed).toMatchObject({
      ok: true,
      tool: "assessment_list",
      data: { count: 1, runs: [{ runId, kind: "assessment", status: "completed" }] },
    });
  });
});
