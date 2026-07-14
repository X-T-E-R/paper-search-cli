import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCitationService } from "../../src/citation/service.js";
import type { CitationProviderRuntime } from "../../src/citation/types.js";
import { ResearchRunStore } from "../../src/runs/store.js";

describe("citation service common-run integration", () => {
  it("creates exactly one common citation record and checkpoints before execution", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-citation-run-"));
    const root = path.join(parent, "runs");
    try {
      const runs = await ResearchRunStore.open({ root, maxAgeDays: -1 });
      let checkpointExistedAtProviderCall = false;
      const provider: CitationProviderRuntime = {
        id: "semantic",
        version: "1.0.0",
        available: true,
        unavailableReasons: [],
        capability: {
          directions: ["backward", "forward"],
          targetIdentifierKinds: ["semantic", "doi", "arxiv"],
          maxPageSize: 100,
        },
        async getCitationPage(request) {
          checkpointExistedAtProviderCall = (await runs.read("common-run")).checkpoint !== undefined;
          return {
            direction: request.direction,
            target: request.target,
            relations: [],
            exhausted: true,
            observedAt: "2026-07-15T00:00:00.000Z",
          };
        },
      };
      const service = createCitationService({
        providers: [provider],
        runs,
        build: { cliVersion: "test" },
      });

      const result = await service.expand({
        mode: "run",
        runId: "common-run",
        seeds: [{ identifiers: { semantic: "A" } }],
        directions: ["backward"],
      });

      expect(result).toMatchObject({ mode: "run", status: "completed", runId: "common-run" });
      expect(checkpointExistedAtProviderCall).toBe(true);
      const jsonFiles = (await readdir(root)).filter((entry) => entry.endsWith(".json"));
      expect(jsonFiles).toEqual(["common-run.json"]);
      expect(await runs.read("common-run")).toMatchObject({
        kind: "citation",
        status: "completed",
        checkpoint: { successfulPages: 1, pending: [] },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reopens a partial common run and continues from its persisted provider cursor", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paper-search-citation-resume-"));
    const root = path.join(parent, "runs");
    try {
      const runs = await ResearchRunStore.open({ root, maxAgeDays: -1 });
      const cursors: string[] = [];
      let secondPageFails = true;
      const provider: CitationProviderRuntime = {
        id: "semantic",
        version: "1.0.0",
        available: true,
        unavailableReasons: [],
        capability: {
          directions: ["backward", "forward"],
          targetIdentifierKinds: ["semantic", "doi", "arxiv"],
          maxPageSize: 100,
        },
        async getCitationPage(request) {
          cursors.push(request.cursor ?? "start");
          if (!request.cursor) {
            return {
              direction: request.direction,
              target: request.target,
              relations: [{
                identifiers: { semantic: "B" },
                item: { itemType: "journalArticle", title: "B" },
              }],
              nextCursor: "opaque-page-2",
              exhausted: false,
              observedAt: "2026-07-15T00:00:00.000Z",
            };
          }
          if (secondPageFails) throw new Error("temporary page error");
          return {
            direction: request.direction,
            target: request.target,
            relations: [],
            exhausted: true,
            observedAt: "2026-07-15T00:01:00.000Z",
          };
        },
      };
      const service = createCitationService({
        providers: [provider],
        runs,
        build: { cliVersion: "test" },
      });
      const partial = await service.expand({
        mode: "run",
        runId: "resume-run",
        seeds: [{ identifiers: { semantic: "A" } }],
        directions: ["backward"],
      });
      expect(partial).toMatchObject({ mode: "run", status: "partial", pendingWorkUnits: 1 });

      secondPageFails = false;
      const resumed = await service.expand({ mode: "resume", runId: "resume-run" });
      expect(resumed).toMatchObject({ mode: "resume", status: "completed", pendingWorkUnits: 0 });
      expect(cursors).toEqual(["start", "opaque-page-2", "opaque-page-2"]);
      expect((await runs.read("resume-run")).status).toBe("completed");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
