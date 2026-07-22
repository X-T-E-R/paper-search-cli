import { describe, expect, it, vi } from "vitest";
import { createCitationService } from "../../src/citation/service.js";
import type {
  CitationProviderRuntime,
  CitationRunPersistence,
} from "../../src/citation/types.js";
import type {
  CreateResearchRunInput,
  FinishResearchRunInput,
  ResearchRunRecord,
  RunProgressUpdate,
} from "../../src/runs/types.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryRuns implements CitationRunPersistence {
  records = new Map<string, ResearchRunRecord>();
  creates = 0;
  progressUpdates = 0;

  async create(input: CreateResearchRunInput): Promise<ResearchRunRecord> {
    this.creates += 1;
    const runId = input.runId ?? `run-${this.creates}`;
    if (this.records.has(runId)) throw new Error(`exists: ${runId}`);
    const now = "2026-07-15T00:00:00.000Z";
    const record: ResearchRunRecord = {
      schemaVersion: 1,
      runId,
      kind: input.kind,
      status: "running",
      startedAt: now,
      updatedAt: now,
      pinned: false,
      request: clone(input.request),
      resolvedSelection: clone(input.resolvedSelection),
      build: input.build,
      provenance: [],
      attempts: [],
      diagnostics: [],
    };
    this.records.set(runId, record);
    return clone(record);
  }

  async read(runId: string): Promise<ResearchRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`not found: ${runId}`);
    return clone(record);
  }

  async resume(runId: string): Promise<ResearchRunRecord> {
    const current = await this.read(runId);
    if (current.status === "completed") throw new Error("not resumable");
    const next = { ...current, status: "running" as const };
    delete next.finishedAt;
    delete next.result;
    this.records.set(runId, next);
    return clone(next);
  }

  async updateProgress(runId: string, update: RunProgressUpdate): Promise<ResearchRunRecord> {
    this.progressUpdates += 1;
    const current = await this.read(runId);
    const next: ResearchRunRecord = {
      ...current,
      checkpoint: update.checkpoint === undefined ? current.checkpoint : clone(update.checkpoint),
      attempts: [...current.attempts, ...clone(update.appendAttempts ?? [])],
      diagnostics: [...current.diagnostics, ...clone(update.appendDiagnostics ?? [])],
      provenance: [...current.provenance, ...clone(update.appendProvenance ?? [])],
    };
    this.records.set(runId, next);
    return clone(next);
  }

  async finish(runId: string, input: FinishResearchRunInput): Promise<ResearchRunRecord> {
    const current = await this.read(runId);
    const next: ResearchRunRecord = {
      ...current,
      status: input.status,
      finishedAt: "2026-07-15T00:10:00.000Z",
      checkpoint: clone(input.checkpoint),
      result: clone(input.result),
    };
    this.records.set(runId, next);
    return clone(next);
  }
}

function paper(id: string) {
  return {
    identifiers: { semantic: id },
    item: { itemType: "journalArticle", title: id },
    providerNativeId: id,
  };
}

function provider(
  id: string,
  getCitationPage: CitationProviderRuntime["getCitationPage"],
): CitationProviderRuntime {
  return {
    id,
    version: "1.0.0",
    available: true,
    unavailableReasons: [],
    capability: {
      directions: ["backward", "forward"],
      targetIdentifierKinds: ["semantic"],
      maxPageSize: 100,
    },
    getCitationPage: vi.fn(getCitationPage),
  };
}

function service(providers: CitationProviderRuntime[], runs = new MemoryRuns()) {
  let tick = 0;
  return {
    runs,
    api: createCitationService({
      providers,
      runs,
      build: { cliVersion: "test" },
      now: () => new Date(Date.UTC(2026, 6, 15, 0, 0, tick++)),
    }),
  };
}

describe("citation service", () => {
  it("plans from manifests without provider calls or run writes", async () => {
    const graph = provider("semantic", async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: [],
      exhausted: true,
      observedAt: "2026-07-15T00:00:00.000Z",
    }));
    const legacy: CitationProviderRuntime = {
      ...graph,
      id: "legacy",
      capability: undefined,
    };
    const { api, runs } = service([graph, legacy]);

    const plan = await api.expand({
      seeds: [{ identifiers: { doi: "https://doi.org/10.1000/ABC" } }],
      providers: ["semantic", "legacy"],
    });

    expect(plan).toMatchObject({ mode: "plan", plannedWorkUnits: 0 });
    if (plan.mode !== "plan") throw new Error("unexpected run");
    expect(runs.creates).toBe(0);
    expect(graph.getCitationPage).not.toHaveBeenCalled();
    expect(plan.providers.find((entry) => entry.providerId === "legacy")?.supported).toBe(false);
  });

  it("routes one normalized multi-identifier seed to providers with different exact-ID support", async () => {
    const emptyPage: CitationProviderRuntime["getCitationPage"] = async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: [],
      exhausted: true,
      observedAt: "2026-07-15T00:00:00.000Z",
    });
    const semantic = provider("semantic", emptyPage);
    const doi: CitationProviderRuntime = {
      ...provider("crossref", emptyPage),
      capability: {
        directions: ["backward", "forward"],
        targetIdentifierKinds: ["doi"],
        maxPageSize: 100,
      },
    };
    const pmid: CitationProviderRuntime = {
      ...provider("pubmed", emptyPage),
      capability: {
        directions: ["backward", "forward"],
        targetIdentifierKinds: ["pmid"],
        maxPageSize: 100,
      },
    };
    const { api, runs } = service([semantic, doi, pmid]);

    const plan = await api.expand({
      seeds: [
        {
          identifiers: {
            doi: "https://doi.org/10.1000/ABC",
            semantic: "S2-Paper",
            pmid: "00042",
          },
        },
      ],
    });

    if (plan.mode !== "plan") throw new Error("unexpected run");
    expect(plan.request.seeds[0]?.identifiers).toEqual({
      doi: "10.1000/abc",
      pmid: "42",
      semantic: "s2-paper",
    });
    expect(plan.plannedWorkUnits).toBe(6);
    expect(
      plan.providers
        .filter((entry) => entry.selected)
        .map((entry) => [entry.providerId, entry.eligibleSeedCount]),
    ).toEqual([
      ["crossref", 1],
      ["pubmed", 1],
      ["semantic", 1],
    ]);
    expect(runs.creates).toBe(0);
    expect(semantic.getCitationPage).not.toHaveBeenCalled();
    expect(doi.getCitationPage).not.toHaveBeenCalled();
    expect(pmid.getCitationPage).not.toHaveBeenCalled();
  });

  it("runs deterministic paged union traversal with directed cites edges and one common run", async () => {
    const first = provider("first", async (request) => {
      if (request.direction === "forward") {
        return {
          direction: request.direction,
          target: request.target,
          relations: [paper("C")],
          exhausted: true,
          observedAt: "2026-07-15T00:03:00.000Z",
        };
      }
      return request.cursor
        ? {
            direction: request.direction,
            target: request.target,
            relations: [paper("D")],
            exhausted: true,
            observedAt: "2026-07-15T00:02:00.000Z",
          }
        : {
            direction: request.direction,
            target: request.target,
            relations: [paper("B")],
            nextCursor: "page-2",
            exhausted: false,
            observedAt: "2026-07-15T00:01:00.000Z",
          };
    });
    const second = provider("second", async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: request.direction === "backward" ? [paper("B")] : [],
      exhausted: true,
      observedAt: "2026-07-15T00:04:00.000Z",
    }));
    const { api, runs } = service([first, second]);

    const result = await api.expand({
      mode: "run",
      runId: "union-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      providers: ["first", "second"],
      limits: { depth: 1 },
    });

    expect(result.mode).toBe("run");
    if (result.mode === "plan") throw new Error("unexpected plan");
    expect(result.status).toBe("completed");
    expect(runs.creates).toBe(1);
    expect(runs.progressUpdates).toBe(6); // initial checkpoint plus five valid pages
    expect(result.nodes.map((node) => node.key)).toEqual([
      "semantic:a",
      "semantic:b",
      "semantic:c",
      "semantic:d",
    ]);
    expect(result.edges.map((edge) => [edge.citingKey, edge.citedKey])).toEqual([
      ["semantic:a", "semantic:b"],
      ["semantic:a", "semantic:d"],
      ["semantic:c", "semantic:a"],
    ]);
    expect(result.edges[0]?.provenance.map((entry) => entry.providerId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("distinguishes partial and all-provider failure, then resumes only pending work", async () => {
    let firstFails = true;
    const first = provider("first", async (request) => {
      if (firstFails) throw new Error("Authorization: Bearer secret-token");
      return {
        direction: request.direction,
        target: request.target,
        relations: [paper("B")],
        exhausted: true,
        observedAt: "2026-07-15T00:00:00.000Z",
      };
    });
    const second = provider("second", async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: [paper("B")],
      exhausted: true,
      observedAt: "2026-07-15T00:00:00.000Z",
    }));
    const { api, runs } = service([first, second]);
    const partial = await api.expand({
      mode: "run",
      runId: "partial-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
      providers: ["first", "second"],
    });
    if (partial.mode === "plan") throw new Error("unexpected plan");
    expect(partial.status).toBe("partial");
    expect(partial.pendingWorkUnits).toBe(1);
    expect(JSON.stringify(await runs.read("partial-run"))).not.toContain("secret-token");

    firstFails = false;
    const resumed = await api.expand({ mode: "resume", runId: "partial-run" });
    if (resumed.mode === "plan") throw new Error("unexpected plan");
    expect(resumed.status).toBe("completed");
    expect(resumed.pendingWorkUnits).toBe(0);
    expect(resumed.edges[0]?.provenance).toHaveLength(2);
    expect(runs.creates).toBe(1);

    const failedProvider = provider("failed", async () => {
      throw new Error("quota exhausted");
    });
    const allFailed = service([failedProvider]);
    const failed = await allFailed.api.expand({
      mode: "run",
      runId: "failed-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
    });
    if (failed.mode === "plan") throw new Error("unexpected plan");
    expect(failed.status).toBe("failed");
    expect(failed.pendingWorkUnits).toBe(1);
  });

  it("resumes an opaque page cursor without repeating a checkpointed page", async () => {
    const cursors: string[] = [];
    let cursorFails = true;
    const paged = provider("paged", async (request) => {
      cursors.push(request.cursor ?? "start");
      if (!request.cursor) {
        return {
          direction: request.direction,
          target: request.target,
          relations: [paper("B")],
          nextCursor: "opaque-2",
          exhausted: false,
          observedAt: "2026-07-15T00:00:00.000Z",
        };
      }
      if (cursorFails) throw new Error("temporary page failure");
      return {
        direction: request.direction,
        target: request.target,
        relations: [paper("C")],
        exhausted: true,
        observedAt: "2026-07-15T00:01:00.000Z",
      };
    });
    const { api } = service([paged]);
    const partial = await api.expand({
      mode: "run",
      runId: "cursor-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
    });
    if (partial.mode === "plan") throw new Error("unexpected plan");
    expect(partial.status).toBe("partial");
    expect(partial.nodes.map((node) => node.key)).toEqual(["semantic:a", "semantic:b"]);

    cursorFails = false;
    const resumed = await api.expand({ mode: "resume", runId: "cursor-run" });
    if (resumed.mode === "plan") throw new Error("unexpected plan");
    expect(resumed.status).toBe("completed");
    expect(resumed.nodes.map((node) => node.key)).toEqual([
      "semantic:a",
      "semantic:b",
      "semantic:c",
    ]);
    expect(cursors).toEqual(["start", "opaque-2", "opaque-2"]);
  });

  it("detects cycles, stops at caps, and fails closed on provider drift", async () => {
    const cycle = provider("cycle", async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: [paper(request.target.identifiers.semantic === "a" ? "B" : "A")],
      exhausted: true,
      observedAt: "2026-07-15T00:00:00.000Z",
    }));
    const cycleRun = service([cycle]);
    const cycled = await cycleRun.api.expand({
      mode: "run",
      runId: "cycle-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
      limits: { depth: 3 },
    });
    if (cycled.mode === "plan") throw new Error("unexpected plan");
    expect(cycle.getCitationPage).toHaveBeenCalledTimes(2);
    expect(cycled.nodes).toHaveLength(2);
    expect(cycled.edges).toHaveLength(2);

    const capped = provider("capped", async (request) => ({
      direction: request.direction,
      target: request.target,
      relations: [paper("B"), paper("C")],
      exhausted: true,
      observedAt: "2026-07-15T00:00:00.000Z",
    }));
    const cappedRun = service([capped]);
    const capResult = await cappedRun.api.expand({
      mode: "run",
      runId: "cap-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
      limits: { nodes: 2 },
    });
    if (capResult.mode === "plan") throw new Error("unexpected plan");
    expect(capResult.status).toBe("partial");
    expect(capResult.capStops).toEqual([{ kind: "nodes", limit: 2 }]);

    let failing = true;
    const drifting = provider("drifting", async (request) => {
      if (failing) throw new Error("temporary");
      return {
        direction: request.direction,
        target: request.target,
        relations: [],
        exhausted: true,
        observedAt: "2026-07-15T00:00:00.000Z",
      };
    });
    const driftRun = service([drifting]);
    await driftRun.api.expand({
      mode: "run",
      runId: "drift-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
    });
    failing = false;
    drifting.version = "2.0.0";
    await expect(
      driftRun.api.expand({ mode: "resume", runId: "drift-run" }),
    ).rejects.toMatchObject({ code: "provider_drift" });
  });

  it("rejects corrupt citation checkpoints before reopening the common run", async () => {
    const failed = provider("failed", async () => {
      throw new Error("temporary");
    });
    const { api, runs } = service([failed]);
    await api.expand({
      mode: "run",
      runId: "corrupt-run",
      seeds: [{ identifiers: { semantic: "A" } }],
      directions: ["backward"],
    });
    const record = await runs.read("corrupt-run");
    record.checkpoint = { schemaVersion: 1, pending: ["not-work"] };
    runs.records.set("corrupt-run", record);

    await expect(
      api.expand({ mode: "resume", runId: "corrupt-run" }),
    ).rejects.toMatchObject({ code: "invalid_checkpoint" });
  });
});
