import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lifecycleEventPath,
  tryAppendLifecycleEvent,
} from "../../src/runtime/eventLedger.js";

const roots: string[] = [];

function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: path.join(root, "appdata"),
    PAPER_SEARCH_INSTALL_TEST_MODE: "1",
    PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
  };
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("lifecycle event ledger", () => {
  it("serializes concurrent credential-free monthly JSONL appends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-events-"));
    roots.push(root);
    const env = testEnv(root);
    const digest = "a".repeat(64);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      tryAppendLifecycleEvent({
        operationId: `operation-${index}`,
        command: "providers install",
        planDigest: digest,
        affectedIds: [`provider_${index}`],
        sourceFingerprint: "b".repeat(64),
        registryDigest: "c".repeat(64),
        archiveSha256: "d".repeat(64),
        outcome: "applied",
      }, env)));
    expect(results.every((result) => result.event !== null && !result.warning)).toBe(true);
    const lines = (await readFile(lifecycleEventPath(undefined, env), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(8);
    const events = lines.map((line) => JSON.parse(line));
    expect(new Set(events.map((event) => event.eventId)).size).toBe(8);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schemaVersion: 1,
        command: "providers install",
        planDigest: digest,
        affectedIds: ["provider_0"],
        outcome: "applied",
      }),
    ]));
    expect(await readFile(lifecycleEventPath(undefined, env), "utf8")).not.toContain("token");
  });

  it("returns an audit warning instead of throwing when the event path is unwritable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-events-failure-"));
    roots.push(root);
    const env = testEnv(root);
    const eventsDir = path.dirname(lifecycleEventPath(undefined, env));
    await mkdir(path.dirname(eventsDir), { recursive: true });
    await writeFile(eventsDir, "not a directory", "utf8");
    const result = await tryAppendLifecycleEvent({
      command: "registries refresh",
      affectedIds: ["official-search"],
      outcome: "applied",
    }, env);
    expect(result).toMatchObject({
      event: null,
      warning: expect.stringContaining("Authoritative state was applied"),
    });
  });
});
