import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../../src/program.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("web command", () => {
  it("returns typed disabled failure without credentials or a process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-web-disabled-"));
    temporary.push(root);
    const oldHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = path.join(root, "paper-search-home");
    let stdout = "";
    try {
      await buildProgram({
        stdout: { write(value: string) { stdout += value; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "web", "offline query"]);
    } finally {
      if (oldHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = oldHome;
    }
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false, tool: "web_search", diagnostics: { reason: "external_search_disabled" },
    });
  });

  it("invokes the native External Search v1 fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-web-native-"));
    temporary.push(root);
    const configRoot = path.join(root, "paper-search-home");
    await mkdir(configRoot, { recursive: true });
    await writeFile(path.join(configRoot, "external-search.toml"), [
      "schemaVersion = 1", "enabled = true", 'adapter = "native"', "timeoutMs = 2000", "",
      "[process]", `executable = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([path.resolve("tests/fixtures/external-search/native-cli.mjs"), "normal"])}`,
      `workingDirectory = ${JSON.stringify(process.cwd())}`, "",
    ].join("\n"));
    const oldHome = process.env.PAPER_SEARCH_HOME;
    process.env.PAPER_SEARCH_HOME = configRoot;
    let stdout = "";
    try {
      await buildProgram({
        stdout: { write(value: string) { stdout += value; } },
        stderr: { write() {} },
      }).parseAsync(["node", "paper-search", "web", "offline query", "--mode", "fast", "--freshness", "pw", "--max-results", "2"]);
    } finally {
      if (oldHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = oldHome;
    }
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      tool: "web_search",
      data: { query: "offline query", results: [{ title: "Fixture result" }] },
      provenance: { semanticVerification: false },
    });
  });
});
