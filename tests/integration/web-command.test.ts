import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
  vi.unstubAllGlobals();
});

describe("web commands", () => {
  it("runs web_search through a configured Tavily backend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-web-cli-"));
    tempDirs.push(root);
    const appData = path.join(root, "appdata");
    await mkdir(path.join(appData, "paper-search"), { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[api.tavily]",
        'baseUrl = "https://tavily.test"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(appData, "paper-search", "credentials.toml"),
      ["schemaVersion = 1", "", "[api.tavily]", 'apiKey = "tvly-test"', ""].join("\n"),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://tavily.test/search");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          query: "RAG evaluation",
          api_key: "tvly-test",
          max_results: 2,
          include_answer: true,
        });
        return new Response(
          JSON.stringify({
            query: "RAG evaluation",
            answer: "Short answer",
            results: [
              {
                title: "RAG Eval",
                url: "https://example.test/rag",
                content: "Snippet",
                score: 0.9,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "web",
        "RAG evaluation",
        "--provider",
        "tavily",
        "--max-results",
        "2",
      ]);
    } finally {
      process.chdir(originalCwd);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "discover",
      tool: "web_search",
      data: {
        provider: "tavily",
        query: "RAG evaluation",
        answer: "Short answer",
        route: { selected: "tavily", reason: "Explicit Tavily" },
      },
    });
    expect(parsed.data.results).toHaveLength(1);
  });

  it("runs web_research through firecrawl search and scrape without live network", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-web-research-cli-"));
    tempDirs.push(root);
    const appData = path.join(root, "appdata");
    await mkdir(path.join(appData, "paper-search"), { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[api.firecrawl]",
        'baseUrl = "https://firecrawl.test"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(appData, "paper-search", "credentials.toml"),
      ["schemaVersion = 1", "", "[api.firecrawl]", 'apiKey = "fc-test"', ""].join("\n"),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "https://firecrawl.test/v2/search") {
          return new Response(
            JSON.stringify({
              data: {
                web: [
                  {
                    title: "Docs Result",
                    url: "https://docs.example.test/page",
                    description: "Docs snippet",
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://firecrawl.test/v2/scrape") {
          return new Response(
            JSON.stringify({
              data: {
                markdown: "# Docs Result\n\nUseful extracted page content.",
                metadata: { sourceURL: "https://docs.example.test/page" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "web-research",
        "API docs",
        "--mode",
        "docs",
        "--web-max-results",
        "1",
        "--scrape-top-n",
        "1",
        "--no-include-social",
      ]);
    } finally {
      process.chdir(originalCwd);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "discover",
      tool: "web_research",
      data: {
        provider: "hybrid",
        query: "API docs",
        evidence: {
          providers_consulted: ["firecrawl"],
          web_result_count: 1,
          page_count: 1,
          citation_count: 1,
        },
      },
    });
    expect(parsed.data.pages[0]).toMatchObject({
      url: "https://docs.example.test/page",
      content: expect.stringContaining("Useful extracted page content"),
    });
  });
});
