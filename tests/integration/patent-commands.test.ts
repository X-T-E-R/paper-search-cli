import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

function stubPatentFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers ?? {});
      const cookie = headers.get("cookie") ?? "";

      if (url === "https://fixture.example/login") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: [
            ["content-type", "application/json"],
            ["set-cookie", "SESSION=fixture-session; Path=/; HttpOnly"],
          ],
        });
      }

      if (url === "https://fixture.example/search") {
        if (!cookie.includes("SESSION=fixture-session")) {
          return new Response(JSON.stringify({ ok: false, error: "missing session cookie" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              platform: "fixture-patent-session",
              query: "solid state battery",
              totalResults: 1,
              items: [
                {
                  itemType: "patent",
                  title: "Solid State Battery Patent",
                  patentNumber: "CN-SSB-001",
                  assignee: "Battery Labs",
                  sourceId: "PAT-001",
                  source: "fixture-patent-session",
                },
              ],
              page: 1,
              hasMore: false,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url === "https://fixture.example/detail") {
        if (!cookie.includes("SESSION=fixture-session")) {
          return new Response(JSON.stringify({ ok: false, error: "missing session cookie" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              item: {
                itemType: "patent",
                title: "Solid State Battery Patent",
                patentNumber: "CN-SSB-001",
                assignee: "Battery Labs",
                sourceId: "PAT-001",
                source: "fixture-patent-session",
              },
              detail: {
                legalStatus: {
                  available: true,
                  entries: [{ date: "2024-03-04", status: "valid", info: "granted" }],
                },
                claims: {
                  available: true,
                  text: "1. A solid-state battery cell...",
                },
                pdf: {
                  available: true,
                  urls: ["https://fixture.example/patent.pdf"],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }),
  );
}

describe("patent commands", () => {
  it("searches patent providers and stores patent detail payloads in the workspace sink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-patent-cli-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    const workspaceRoot = path.join(root, "workspace");
    const appData = path.join(root, "appdata");
    const paperSearchHome = path.join(root, "home");
    await mkdir(path.join(installDir, "fixture-patent-session"), { recursive: true });
    await mkdir(paperSearchHome, { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = \"${installDir.replace(/\\/g, "\\\\")}\"`,
        "",
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[platform.fixture-patent-session]",
        'enabled = true',
        'loginName = "fixture-user"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(paperSearchHome, "credentials.toml"),
      ["schemaVersion = 1", "", "[platform.fixture-patent-session]", 'password = "fixture-pass"', ""].join("\n"),
      "utf8",
    );
    const fixtureDir = path.resolve(
      "tests",
      "fixtures",
      "provider-packages",
      "fixture-patent-session",
    );
    await writeFile(
      path.join(installDir, "fixture-patent-session", "manifest.json"),
      await readFile(path.join(fixtureDir, "manifest.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "fixture-patent-session", "provider.js"),
      await readFile(path.join(fixtureDir, "provider.js"), "utf8"),
      "utf8",
    );
    stubPatentFetch();

    const originalCwd = process.cwd();
    const originalAppData = process.env.APPDATA;
    const originalPaperSearchHome = process.env.PAPER_SEARCH_HOME;
    process.env.APPDATA = appData;
    process.env.PAPER_SEARCH_HOME = paperSearchHome;
    process.chdir(root);

    let patentStdout = "";
    let detailStdout = "";
    let addStdout = "";
    try {
      await buildProgram({
        stdout: { write(chunk: string) { patentStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync([
        "node",
        "paper-search",
        "patent",
        "solid state battery",
        "--platform",
        "fixture-patent-session",
        "--database",
        "CN",
        "--patent-type",
        "invention",
      ]);

      await buildProgram({
        stdout: { write(chunk: string) { detailStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync([
        "node",
        "paper-search",
        "patent-detail",
        "fixture-patent-session",
        "PAT-001",
        "--include",
        "legalStatus,claims,pdf",
      ]);

      const detailPath = path.join(root, "patent-detail.json");
      await writeFile(detailPath, detailStdout, "utf8");
      await buildProgram({
        stdout: { write(chunk: string) { addStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync([
        "node",
        "paper-search",
        "resource-add",
        "--item-file",
        detailPath,
        "--detail-file",
        detailPath,
        "--collection-path",
        "Patents/Inbox",
        "--tags",
        "battery,patent",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalPaperSearchHome === undefined) delete process.env.PAPER_SEARCH_HOME;
      else process.env.PAPER_SEARCH_HOME = originalPaperSearchHome;
    }

    const patent = JSON.parse(patentStdout);
    expect(patent).toMatchObject({ ok: true, capability: "discover", tool: "patent_search" });
    expect(patent.data.platform).toBe("fixture-patent-session");
    expect(patent.data.items[0].patentNumber).toBe("CN-SSB-001");

    const detail = JSON.parse(detailStdout);
    expect(detail).toMatchObject({ ok: true, capability: "identify", tool: "patent_detail" });
    expect(detail.data.detail.claims.text).toContain("solid-state battery");
    expect(detail.data.detail.pdf.urls).toEqual(["https://fixture.example/patent.pdf"]);

    const added = JSON.parse(addStdout);
    expect(added).toMatchObject({ ok: true, capability: "organize", tool: "resource_add" });
    expect(added.data.record.item.title).toBe("Solid State Battery Patent");
    expect(added.data.record.detail.claims.text).toContain("solid-state battery");
    expect(added.data.collection.path).toBe("Patents/Inbox");
  });
});
