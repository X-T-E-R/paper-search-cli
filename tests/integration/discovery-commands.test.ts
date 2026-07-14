import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});

describe("discovery commands", () => {
  it("exposes tools, help, and platform status for installed providers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-discovery-"));
    tempDirs.push(root);
    const installDir = path.join(root, "providers");
    await mkdir(path.join(installDir, "alpha"), { recursive: true });
    await mkdir(path.join(installDir, "patent-alpha"), { recursive: true });
    const appData = path.join(root, "appdata");
    await mkdir(path.join(appData, "paper-search"), { recursive: true });
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = \"${installDir.replace(/\\/g, "\\\\")}\"`,
        "",
        "[platform.alpha]",
        'enabled = true',
        "",
        "[platform.patent-alpha]",
        'enabled = true',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "alpha", "manifest.json"),
      JSON.stringify({
        id: "alpha",
        name: "Alpha Provider",
        version: "1.0.0",
        sourceType: "academic",
        description: "Alpha academic provider",
        permissions: { urls: ["https://alpha.example/*"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "patent-alpha", "manifest.json"),
      JSON.stringify({
        id: "patent-alpha",
        name: "Patent Alpha",
        version: "1.0.0",
        sourceType: "patent",
        description: "Patent provider",
        permissions: { urls: ["https://patent-alpha.example/*"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(installDir, "patent-alpha", "provider.js"),
      "globalThis.__zrs_exports = { createProvider(){ return { async search(){ return { platform:'patent-alpha', query:'', totalResults:0, items:[], page:1 }; }, async getDetail(){ return { item:{ itemType:'patent', title:'Patent Alpha', sourceId:'P-1' }, detail:{} }; } }; } };",
      "utf8",
    );
    await writeFile(
      path.join(installDir, "alpha", "provider.js"),
      "globalThis.__zrs_exports = { createProvider(){ return { async search(){ return { platform:'alpha', query:'', totalResults:0, items:[], page:1 }; } }; } };",
      "utf8",
    );

    const originalCwd = process.cwd();
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    process.chdir(root);

    let toolsStdout = "";
    let helpStdout = "";
    let statusStdout = "";
    try {
      await buildProgram({
        stdout: { write(chunk: string) { toolsStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync(["node", "paper-search", "tools", "--json"]);

      await buildProgram({
        stdout: { write(chunk: string) { helpStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync(["node", "paper-search", "help", "providers", "--provider", "alpha", "--locale", "en"]);

      await buildProgram({
        stdout: { write(chunk: string) { statusStdout += chunk; } },
        stderr: { write() { /* ignore */ } },
      }).parseAsync(["node", "paper-search", "platform-status", "--json"]);
    } finally {
      process.chdir(originalCwd);
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }

    const tools = JSON.parse(toolsStdout);
    const academicTool = tools.tools.find((entry: { name: string }) => entry.name === "academic_search");
    const patentSearchTool = tools.tools.find((entry: { name: string }) => entry.name === "patent_search");
    const patentDetailTool = tools.tools.find((entry: { name: string }) => entry.name === "patent_detail");
    const resourcePdfTool = tools.tools.find((entry: { name: string }) => entry.name === "resource_pdf");
    expect(academicTool.inputSchema.properties.platform.enum).toBeUndefined();
    expect(academicTool.inputSchema.properties.sources.items.enum).toBeUndefined();
    expect(patentSearchTool.inputSchema.properties.platform.enum).toBeUndefined();
    expect(patentSearchTool.inputSchema.properties.sources.items.enum).toBeUndefined();
    expect(patentDetailTool.inputSchema.properties.platform.enum).toEqual(["patent-alpha"]);
    expect(tools.tools.find((entry: { name: string }) => entry.name === "web_search")).toBeUndefined();
    expect(resourcePdfTool.inputSchema.required).toEqual(["itemKey"]);
    expect(tools.cliMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "resource_lookup" }),
        expect.objectContaining({ tool: "resource_pdf", commands: expect.arrayContaining(["resource-pdf"]) }),
      ]),
    );

    const help = JSON.parse(helpStdout);
    expect(help.providers).toEqual([
      expect.objectContaining({
        id: "alpha",
        sourceType: "academic",
      }),
    ]);
    expect(help.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("web_search")]),
    );

    const status = JSON.parse(statusStdout);
    expect(status).toMatchObject({ ok: true, capability: "operate", tool: "platform_status" });
    expect(status.data.availableTools).toContain("mcp_help");
    expect(status.data.academic).toEqual([
      expect.objectContaining({
        id: "alpha",
        enabled: true,
        configured: true,
      }),
    ]);
    expect(status.data.patent).toEqual([
      expect.objectContaining({
        id: "patent-alpha",
        enabled: true,
        configured: true,
      }),
    ]);
    expect(status.data.web).toEqual([]);
    expect(status.data.externalSearch.state).toBe("disabled");
  });
});
