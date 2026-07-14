import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactRecord } from "../../src/material/artifactStore.js";
import { createExtractionRecord } from "../../src/material/extractionStore.js";
import type { MaterialStatusData } from "../../src/material/status.js";
import { buildProgram } from "../../src/index.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }),
  );
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function writeProjectConfig(root: string, workspaceRoot: string): Promise<void> {
  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[workspace]",
      `root = "${tomlPath(workspaceRoot)}"`,
      'defaultCollection = "Inbox"',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function runMaterialStatusCommand(root: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  envelope: ResultEnvelope;
}> {
  let stdout = "";
  let stderr = "";
  const originalCwd = process.cwd();
  const originalAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, "appdata");
  process.chdir(root);
  try {
    await buildProgram({
      stdout: { write(chunk: string) { stdout += chunk; } },
      stderr: { write(chunk: string) { stderr += chunk; } },
    })
      .exitOverride()
      .parseAsync(["node", "paper-search", ...args]);
  } finally {
    process.chdir(originalCwd);
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
  }
  const envelope = JSON.parse(stdout) as ResultEnvelope;
  expect(isResultEnvelope(envelope)).toBe(true);
  return { stdout, stderr, envelope };
}

async function createWorkspace(prefix: string): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await writeProjectConfig(root, workspaceRoot);
  return { root, workspaceRoot };
}

function expectStatusData(envelope: ResultEnvelope): MaterialStatusData {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "orchestrate",
    tool: "material_status",
  });
  expect(envelope.data).not.toBeNull();
  return envelope.data as MaterialStatusData;
}

describe("material status command", () => {
  it("reports a workspace item with artifacts and extracted outputs", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-material-status-with-");
    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "Material Status Article",
        url: "https://example.test/article",
      },
      defaultCollectionPath: "Inbox",
    });
    const artifact = await createArtifactRecord(workspaceRoot, {
      kind: "pdf",
      status: "downloaded",
      itemId: addResult.record.id,
      filename: "material-status.pdf",
      contentType: "application/pdf",
      path: "material/files/material-status.pdf",
      remoteUrl: "https://example.test/article.pdf",
      sizeBytes: 17,
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/article.pdf",
        providerId: "fixture-artifact-downloader",
        policy: "workspace-safe",
      },
      attempts: [
        {
          tier: "integration-fixture",
          source: "https://example.test/article.pdf",
          providerId: "fixture-artifact-downloader",
          ok: true,
          status: 200,
          at: "2026-06-29T00:00:00.000Z",
        },
      ],
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    const extraction = await createExtractionRecord(workspaceRoot, {
      source: { kind: "artifact", artifactId: artifact.id },
      backend: "fixture-markdown-extractor",
      options: {
        policy: "workspace-safe",
      },
      outputs: {
        markdownPath: `material/extracted/${artifact.id}.md`,
        jsonPath: `material/extracted/${artifact.id}.json`,
      },
      cacheHit: false,
      itemId: addResult.record.id,
      createdAt: "2026-06-29T00:01:00.000Z",
    });

    const result = await runMaterialStatusCommand(root, [
      "material",
      "status",
      addResult.record.id,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectStatusData(result.envelope);
    expect(data).toMatchObject({
      target: {
        kind: "workspace_item",
        id: addResult.record.id,
        itemId: addResult.record.id,
      },
      hasArtifacts: true,
      artifactCount: 1,
      artifactIds: [artifact.id],
      hasExtractedOutputs: true,
      extractedOutputCount: 1,
      extractionCount: 1,
      extractionIds: [extraction.id],
      relatedItemIds: [addResult.record.id],
    });
    expect(data.item?.id).toBe(addResult.record.id);
    expect(data.artifacts[0]).toMatchObject({ id: artifact.id, itemId: addResult.record.id });
    expect(data.extractions[0]).toMatchObject({
      id: extraction.id,
      itemId: addResult.record.id,
      source: { kind: "artifact", artifactId: artifact.id },
    });
    expect(data.extractedOutputs).toEqual([
      {
        extractionId: extraction.id,
        status: "extracted",
        markdownPath: `material/extracted/${artifact.id}.md`,
        jsonPath: `material/extracted/${artifact.id}.json`,
        hasInlineMarkdown: false,
      },
    ]);
    expect(result.envelope).toMatchObject({
      diagnostics: {
        workspaceRoot,
        targetId: addResult.record.id,
        targetKind: "workspace_item",
        sourceCounts: {
          artifacts: 1,
          extractions: 1,
          extractedOutputs: 1,
        },
      },
      provenance: {
        providerIds: ["fixture-artifact-downloader", "fixture-markdown-extractor"],
      },
    });
  });

  it("reports a workspace item without artifacts or extracted outputs", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-material-status-without-");
    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "No Material Article",
        url: "https://example.test/no-material",
      },
      defaultCollectionPath: "Inbox",
    });

    const result = await runMaterialStatusCommand(root, [
      "material",
      "status",
      addResult.record.id,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectStatusData(result.envelope);
    expect(data).toMatchObject({
      target: {
        kind: "workspace_item",
        id: addResult.record.id,
        itemId: addResult.record.id,
      },
      hasArtifacts: false,
      artifactCount: 0,
      artifactIds: [],
      artifacts: [],
      hasExtractedOutputs: false,
      extractedOutputCount: 0,
      extractedOutputs: [],
      extractionCount: 0,
      extractionIds: [],
      extractions: [],
      relatedItemIds: [addResult.record.id],
    });
    expect(result.envelope).toMatchObject({
      diagnostics: {
        workspaceRoot,
        targetId: addResult.record.id,
        targetKind: "workspace_item",
        sourceCounts: {
          artifacts: 0,
          extractions: 0,
          extractedOutputs: 0,
        },
      },
    });
  });

  it("resolves artifact and extraction ids", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-material-status-direct-");
    const artifact = await createArtifactRecord(workspaceRoot, {
      kind: "pdf",
      status: "recorded",
      filename: "direct-artifact.pdf",
      remoteUrl: "https://example.test/direct-artifact.pdf",
      provenance: {
        origin: "user_supplied",
        providerId: "fixture-artifact-downloader",
      },
      attempts: [
        {
          tier: "integration-fixture",
          ok: true,
          at: "2026-06-29T00:00:00.000Z",
        },
      ],
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    const extraction = await createExtractionRecord(workspaceRoot, {
      source: { kind: "artifact", artifactId: artifact.id },
      backend: "fixture-markdown-extractor",
      outputs: {
        markdown: "# Inline extraction",
      },
      cacheHit: true,
      createdAt: "2026-06-29T00:01:00.000Z",
    });

    const artifactResult = await runMaterialStatusCommand(root, [
      "material",
      "status",
      artifact.id,
      "--json",
    ]);
    const artifactData = expectStatusData(artifactResult.envelope);
    expect(artifactData).toMatchObject({
      target: {
        kind: "artifact",
        id: artifact.id,
        artifactId: artifact.id,
      },
      hasArtifacts: true,
      artifactCount: 1,
      artifactIds: [artifact.id],
      hasExtractedOutputs: true,
      extractedOutputCount: 1,
      extractionIds: [extraction.id],
    });

    const extractionResult = await runMaterialStatusCommand(root, [
      "material",
      "status",
      extraction.id,
      "--json",
    ]);
    const extractionData = expectStatusData(extractionResult.envelope);
    expect(extractionData).toMatchObject({
      target: {
        kind: "extraction",
        id: extraction.id,
        extractionId: extraction.id,
        artifactId: artifact.id,
      },
      hasArtifacts: true,
      artifactCount: 1,
      artifactIds: [artifact.id],
      hasExtractedOutputs: true,
      extractedOutputCount: 1,
      extractionIds: [extraction.id],
      extractedOutputs: [
        {
          extractionId: extraction.id,
          status: "extracted",
          hasInlineMarkdown: true,
        },
      ],
    });
  });

  it("returns a fail envelope for unknown ids", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-material-status-missing-");

    const result = await runMaterialStatusCommand(root, [
      "material",
      "status",
      "missing-material-id",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "orchestrate",
      tool: "material_status",
      data: null,
      errors: ["Material status target not found: missing-material-id"],
      diagnostics: {
        workspaceRoot,
        targetId: "missing-material-id",
      },
    });
  });
});
