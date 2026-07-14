import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function runSelf(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-self-command-"));
  tempDirs.push(root);
  let stdout = "";
  let stderr = "";
  const previous = {
    testMode: process.env.PAPER_SEARCH_INSTALL_TEST_MODE,
    dataRoot: process.env.PAPER_SEARCH_TEST_DATA_ROOT,
    origin: process.env.PAPER_SEARCH_OFFICIAL_ORIGIN,
  };
  process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
  process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(root, "data");
  process.env.PAPER_SEARCH_OFFICIAL_ORIGIN = "https://override.invalid/paper-search.git";
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    }).parseAsync(["node", "paper-search", "self", ...args]);
  } finally {
    for (const [name, value] of [
      ["PAPER_SEARCH_INSTALL_TEST_MODE", previous.testMode],
      ["PAPER_SEARCH_TEST_DATA_ROOT", previous.dataRoot],
      ["PAPER_SEARCH_OFFICIAL_ORIGIN", previous.origin],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return { stdout, stderr };
}

describe("self command production composition", () => {
  it("reports the source-sealed official origin policy without exposing an override", async () => {
    const { stdout, stderr } = await runSelf(["update", "--json"]);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: true,
      tool: "self_update",
      planned: true,
      data: {
        applied: false,
        plan: {
          blocked: true,
          officialPolicy: {
            status: "available",
            policyId: "paper-search-official-origin-v1",
            matched: false,
          },
        },
      },
    });
    expect(envelope.data.plan.blockers.join(" ")).toContain("official origin policy");
    expect(JSON.stringify(envelope)).not.toContain("override.invalid");
  });

  it("keeps self-update opt-in plan-first and blocked outside an owned official clone", async () => {
    const { stdout } = await runSelf(["mode", "self-update", "--json"]);
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: true,
      tool: "self_mode",
      planned: true,
      data: {
        applied: false,
        plan: {
          after: "self-update",
          blocked: true,
          officialPolicy: { status: "available", matched: false },
        },
      },
    });
  });

  it("adds Git/upstream and recovery details without removing install-health fields", async () => {
    const { stdout } = await runSelf(["status", "--json"]);
    const envelope = JSON.parse(stdout);
    expect(envelope.data).toHaveProperty("paths.repoRoot");
    expect(envelope.data).toHaveProperty("summary.status");
    expect(envelope.data).toHaveProperty("checkout.git");
    expect(envelope.data.checkout.officialPolicy.status).toBe("available");
  });
});
