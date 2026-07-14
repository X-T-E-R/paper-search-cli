import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactRecord } from "../../src/material/artifactStore.js";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function runArtifactCommand(root: string, args: string[]): Promise<{
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
    restoreEnv("APPDATA", originalAppData);
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

describe("artifact list and show commands", () => {
  it("lists artifact records by workspace item id and shows one by artifact id", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-list-");
    const linked = await createArtifactRecord(workspaceRoot, {
      id: "linked-artifact",
      createdAt: "2026-06-29T10:00:00.000Z",
      kind: "pdf",
      status: "downloaded",
      itemId: "item-123",
      filename: "paper.pdf",
      contentType: "application/pdf",
      path: "attachments/item-123/paper.pdf",
      remoteUrl: "https://example.test/paper.pdf",
      provenance: {
        origin: "download",
        sourceUrl: "https://example.test/paper.pdf",
        providerId: "fixture-downloader",
        policy: "workspace-safe",
      },
      attempts: [
        {
          tier: "primary",
          source: "fixture",
          providerId: "fixture-downloader",
          ok: true,
          status: 200,
          at: "2026-06-29T10:00:00.000Z",
        },
      ],
    });
    await createArtifactRecord(workspaceRoot, {
      id: "other-item-artifact",
      createdAt: "2026-06-29T10:01:00.000Z",
      kind: "html",
      status: "recorded",
      itemId: "item-456",
      remoteUrl: "https://example.test/other.html",
      provenance: {
        origin: "resolved",
        sourceUrl: "https://example.test/other.html",
      },
      attempts: [
        {
          tier: "metadata",
          ok: true,
          at: "2026-06-29T10:01:00.000Z",
        },
      ],
    });

    const listResult = await runArtifactCommand(root, ["artifact", "list", "--item", "item-123", "--json"]);
    expect(listResult.stderr).toBe("");
    expect(listResult.envelope).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_list",
      data: {
        count: 1,
        itemId: "item-123",
        records: [
          {
            id: linked.id,
            itemId: "item-123",
            kind: "pdf",
            status: "downloaded",
            path: "attachments/item-123/paper.pdf",
          },
        ],
      },
      diagnostics: {
        workspaceRoot,
        sourceCounts: { artifacts: 1 },
      },
    });

    const showResult = await runArtifactCommand(root, ["artifact", "show", linked.id, "--json"]);
    expect(showResult.stderr).toBe("");
    expect(showResult.envelope).toMatchObject({
      ok: true,
      capability: "acquire",
      tool: "artifact_show",
      data: {
        record: {
          id: linked.id,
          itemId: "item-123",
          provenance: {
            origin: "download",
            providerId: "fixture-downloader",
            policy: "workspace-safe",
          },
        },
      },
      provenance: {
        providerIds: ["fixture-downloader"],
        policy: "workspace-safe",
      },
    });
  });

  it("returns a failure envelope when artifact show cannot find the id", async () => {
    const { root, workspaceRoot } = await createWorkspace("paper-search-artifact-show-missing-");

    const result = await runArtifactCommand(root, ["artifact", "show", "missing-artifact", "--json"]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "acquire",
      tool: "artifact_show",
      data: null,
      errors: ["Artifact not found: missing-artifact"],
      diagnostics: {
        workspaceRoot,
        artifactId: "missing-artifact",
      },
    });
  });
});
