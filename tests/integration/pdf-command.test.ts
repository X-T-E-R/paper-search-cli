import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import { buildProgram } from "../../src/program.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];

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
  it("fetches a PDF into the configured local attachment sink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pdf-cli-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
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

    const fetchMock = vi.fn(async () =>
      new Response("cli-pdf", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
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
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/files/cli.pdf", {
      headers: { accept: "application/pdf,*/*" },
    });
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
        path: `attachments/${addResult.record.id}/cli-paper.pdf`,
        message: "PDF fetched into local workspace attachments",
        attachment: {
          itemId: addResult.record.id,
          artifactId: expect.any(String),
        },
      },
    });
    expect(parsed.data.artifactId).not.toBe(addResult.record.id);
    expect(parsed.data.attachment.artifactId).toBe(parsed.data.artifactId);
    await expect(
      readFile(path.join(workspaceRoot, parsed.data.path), "utf8"),
    ).resolves.toBe("cli-pdf");
    await expect(readArtifactRecord(workspaceRoot, parsed.data.artifactId)).resolves.toMatchObject({
      id: parsed.data.artifactId,
      kind: "pdf",
      status: "downloaded",
      itemId: addResult.record.id,
      filename: "cli-paper.pdf",
      path: `attachments/${addResult.record.id}/cli-paper.pdf`,
      remoteUrl: "https://example.test/files/cli.pdf",
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/files/cli.pdf",
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
        "[workspace]",
        `root = \"${workspaceRoot.replace(/\\/g, "\\\\")}\"`,
        'defaultCollection = "Inbox"',
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
        message: "PDF fetch recorded but download was not requested",
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
});
