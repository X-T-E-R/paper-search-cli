import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import { buildProgram } from "../../src/program.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];
const downloaderFixturesRoot = path.resolve("tests", "fixtures", "material-downloaders");

afterEach(async () => {
  vi.unstubAllGlobals();
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

describe("resource-pdf command", () => {
  it("fetches a PDF into configured local artifact storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pdf-cli-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${downloaderFixturesRoot.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `artifactRoot = "${path.join(root, "artifact-storage").replace(/\\/g, "\\\\")}"`,
        `extractionRoot = "${path.join(root, "extraction-storage").replace(/\\/g, "\\\\")}"`,
        `exportRoot = "${path.join(root, "exports").replace(/\\/g, "\\\\")}"`,
        "",
        "[platform.fixture-artifact-downloader]",
        'mode = "integration"',
        "",
      ].join("\n"),
      "utf8",
    );

    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "CLI PDF article",
        url: "https://example.test/landing",
      },
      defaultCollectionPath: "Inbox",
    });

    const fetchMock = vi.fn(async () => { throw new Error("core fetch must not run"); });
    vi.stubGlobal("fetch", fetchMock);

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "resource-pdf",
        addResult.record.id,
        "--url",
        "https://example.test/files/cli.pdf",
        "--filename",
        "cli-paper",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "resource_pdf",
      data: {
        ok: true,
        itemKey: addResult.record.id,
        itemId: addResult.record.id,
        attachmentId: expect.any(String),
        artifactId: expect.any(String),
        filename: "cli-paper.pdf",
        storage: {
          schemaVersion: 1,
          sink: "local",
          area: "artifact",
          root: path.join(root, "artifact-storage"),
          key: expect.stringMatching(/\/cli-paper\.pdf$/u),
        },
        message: "PDF acquired through material provider and attached to the workspace item",
        attachment: {
          itemId: addResult.record.id,
          artifactId: expect.any(String),
        },
      },
    });
    expect(parsed.data.artifactId).not.toBe(addResult.record.id);
    expect(parsed.data.attachment.artifactId).toBe(parsed.data.artifactId);
    await expect(
      readFile(path.join(parsed.data.storage.root, parsed.data.storage.key), "utf8"),
    ).resolves.toBe("fixture downloader bytes\n");
    await expect(readArtifactRecord(workspaceRoot, parsed.data.artifactId)).resolves.toMatchObject({
      id: parsed.data.artifactId,
      kind: "pdf",
      status: "downloaded",
      itemId: addResult.record.id,
      filename: "cli-paper.pdf",
      storage: parsed.data.storage,
      remoteUrl: "https://example.test/files/cli.pdf",
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/files/cli.pdf",
        providerId: "fixture-artifact-downloader",
      },
    });
  });

  it("keeps the pdf alias and returns separate workspace item and artifact ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pdf-alias-cli-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${downloaderFixturesRoot.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `artifactRoot = "${path.join(root, "artifact-storage").replace(/\\/g, "\\\\")}"`,
        `extractionRoot = "${path.join(root, "extraction-storage").replace(/\\/g, "\\\\")}"`,
        `exportRoot = "${path.join(root, "exports").replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "CLI PDF alias article",
      },
      defaultCollectionPath: "Inbox",
    });

    const fetchMock = vi.fn(async () => {
      throw new Error("alias no-download test must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    let stdout = "";
    let stderr = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({
        stdout: { write(chunk: string) { stdout += chunk; } },
        stderr: { write(chunk: string) { stderr += chunk; } },
      }).parseAsync([
        "node",
        "paper-search",
        "pdf",
        addResult.record.id,
        "--url",
        "https://example.test/files/alias.pdf",
        "--no-download",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(stderr).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "resource_pdf",
      data: {
        ok: true,
        itemKey: addResult.record.id,
        itemId: addResult.record.id,
        attachmentId: expect.any(String),
        artifactId: expect.any(String),
        sourceUrl: "https://example.test/files/alias.pdf",
        message: "PDF acquisition recorded through material provider without downloading bytes",
      },
    });
    expect(parsed.data.artifactId).not.toBe(addResult.record.id);
    expect(parsed.data.attachmentId).not.toBe(addResult.record.id);
    await expect(readArtifactRecord(workspaceRoot, parsed.data.artifactId)).resolves.toMatchObject({
      id: parsed.data.artifactId,
      kind: "pdf",
      status: "requested",
      itemId: addResult.record.id,
      remoteUrl: "https://example.test/files/alias.pdf",
      provenance: {
        origin: "resolved",
        sourceUrl: "https://example.test/files/alias.pdf",
      },
    });
  });

  it("does not let a requested PDF suppress a later default acquisition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pdf-request-then-acquire-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${downloaderFixturesRoot.replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = "${workspaceRoot.replace(/\\/g, "\\\\")}"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `artifactRoot = "${path.join(root, "artifact-storage").replace(/\\/g, "\\\\")}"`,
        `extractionRoot = "${path.join(root, "extraction-storage").replace(/\\/g, "\\\\")}"`,
        `exportRoot = "${path.join(root, "exports").replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "Requested then acquired" },
      defaultCollectionPath: "Inbox",
    });

    const runPdf = async (args: string[]): Promise<Record<string, unknown>> => {
      let stdout = "";
      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        await buildProgram({ stdout: { write(chunk: string) { stdout += chunk; } } }).parseAsync([
          "node", "paper-search", ...args,
        ]);
      } finally {
        process.chdir(originalCwd);
      }
      return JSON.parse(stdout) as Record<string, unknown>;
    };

    const requested = await runPdf([
      "resource-pdf", added.record.id, "--url", "https://example.test/files/requested.pdf", "--no-download", "--json",
    ]);
    expect(requested).toMatchObject({
      ok: true,
      data: { artifactId: expect.any(String), message: "PDF acquisition recorded through material provider without downloading bytes" },
    });
    const requestedArtifactId = (requested.data as { artifactId: string }).artifactId;

    const acquired = await runPdf([
      "resource-pdf", added.record.id, "--url", "https://example.test/files/requested.pdf", "--json",
    ]);
    expect(acquired).toMatchObject({
      ok: true,
      tool: "resource_pdf",
      data: {
        artifactId: expect.any(String),
        message: "PDF acquired through material provider and attached to the workspace item",
        storage: { area: "artifact", key: expect.stringMatching(/\.pdf$/u) },
      },
    });
    const acquiredData = acquired.data as { artifactId: string; storage: { root: string; key: string } };
    expect(acquiredData.artifactId).not.toBe(requestedArtifactId);
    await expect(readFile(path.join(acquiredData.storage.root, acquiredData.storage.key), "utf8")).resolves.toBe(
      "fixture downloader bytes\n",
    );
  });

  it("fails actionably without a downloader and never restores direct core HTTP fetching", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pdf-no-provider-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${path.join(root, "empty-providers").replace(/\\/g, "\\\\")}"`,
        "",
        "[workspace]",
        `root = "${workspaceRoot.replace(/\\/g, "\\\\")}"`,
        'defaultCollection = "Inbox"',
        "",
        "[storage]",
        `artifactRoot = "${path.join(root, "artifact-storage").replace(/\\/g, "\\\\")}"`,
        `extractionRoot = "${path.join(root, "extraction-storage").replace(/\\/g, "\\\\")}"`,
        `exportRoot = "${path.join(root, "exports").replace(/\\/g, "\\\\")}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    const added = await addResourceToWorkspace(workspaceRoot, {
      item: { itemType: "journalArticle", title: "No provider" },
      defaultCollectionPath: "Inbox",
    });
    const fetchMock = vi.fn(async () => { throw new Error("direct fetch must remain disabled"); });
    vi.stubGlobal("fetch", fetchMock);
    let stdout = "";
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await buildProgram({ stdout: { write(chunk: string) { stdout += chunk; } } }).parseAsync([
        "node", "paper-search", "resource-pdf", added.record.id, "--url", "https://example.test/no-provider.pdf", "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      tool: "resource_pdf",
      errors: [expect.stringContaining("No usable material artifact downloader provider")],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
