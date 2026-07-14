import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterialExtractionData } from "../../src/material/extract.js";
import { buildProgram } from "../../src/program.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";

const tempDirs: string[] = [];
const extractorFixturesRoot = path.resolve("tests", "fixtures", "material-extractors");

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

async function writeProjectConfig(
  root: string,
  workspaceRoot: string,
  installDir = extractorFixturesRoot,
): Promise<void> {
  await writeFile(
    path.join(root, "paper-search.toml"),
    [
      "[providers]",
      `installDir = "${tomlPath(installDir)}"`,
      "",
      "[workspace]",
      `root = "${tomlPath(workspaceRoot)}"`,
      'defaultCollection = "Inbox"',
      "",
      "[platform.fixture-markdown-extractor]",
      'mode = "integration"',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function runExtractCommand(root: string, args: string[]): Promise<{
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

async function createWorkspaceFixture(prefix: string): Promise<{ root: string; workspaceRoot: string; inputPath: string }> {
  const root = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await writeProjectConfig(root, workspaceRoot);
  const inputDir = path.join(root, "inputs");
  await mkdir(inputDir, { recursive: true });
  const inputPath = path.join(inputDir, "paper.txt");
  await writeFile(inputPath, "fixture source body\n", "utf8");
  return { root, workspaceRoot, inputPath };
}

function expectExtractionData(envelope: ResultEnvelope): MaterialExtractionData {
  expect(envelope).toMatchObject({
    ok: true,
    capability: "extract",
    tool: "extract",
  });
  expect(envelope.data).not.toBeNull();
  return envelope.data as MaterialExtractionData;
}

describe("extract command", () => {
  it("extracts a standalone local path without requiring a workspace item", async () => {
    const { root, workspaceRoot, inputPath } = await createWorkspaceFixture("paper-search-extract-path-");

    const result = await runExtractCommand(root, [
      "extract",
      inputPath,
      "--provider",
      "fixture-markdown-extractor",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectExtractionData(result.envelope);
    expect(data.provider.id).toBe("fixture-markdown-extractor");
    expect(data.provider.packagePath).toBe(
      path.join(extractorFixturesRoot, "fixture-markdown-extractor"),
    );
    expect(data.record.itemId).toBeUndefined();
    expect(data.record.source).toEqual({ kind: "path", path: inputPath });
    expect(data.markdown).toContain("# Fixture Markdown Extraction");
    expect(data.markdown).toContain("Source kind: path");
    expect(data.markdown).toContain(`Source: ${inputPath}`);
    expect(data.markdown).toContain("Attachment: standalone");
    expect(data.markdown).toContain("Mode: integration");

    await expect(readFile(path.join(workspaceRoot, data.record.outputs.markdownPath!), "utf8")).resolves.toBe(
      data.markdown,
    );
    await expect(
      readFile(path.join(workspaceRoot, "material", "extractions", `${data.record.id}.json`), "utf8"),
    ).resolves.toContain('"backend": "fixture-markdown-extractor"');
    await expect(readFile(path.join(workspaceRoot, data.record.outputs.jsonPath!), "utf8")).resolves.toContain(
      '"fixture": true',
    );
  });

  it("prefers the v1 material path over a legacy flat provider with the same id", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "paper-search-extract-kind-path-")),
    );
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const providersRoot = path.join(root, "providers");
    const providerId = "fixture-markdown-extractor";
    const fixturePath = path.join(extractorFixturesRoot, providerId);
    const kindPath = path.join(providersRoot, "material", providerId);
    const legacyPath = path.join(providersRoot, providerId);
    await cp(fixturePath, kindPath, { recursive: true });
    await mkdir(legacyPath, { recursive: true });
    await writeFile(path.join(legacyPath, "manifest.json"), "{}", "utf8");
    await writeProjectConfig(root, workspaceRoot, providersRoot);
    const inputPath = path.join(root, "paper.txt");
    await writeFile(inputPath, "fixture source body\n", "utf8");

    const result = await runExtractCommand(root, [
      "extract",
      inputPath,
      "--provider",
      providerId,
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectExtractionData(result.envelope);
    expect(data.provider).toMatchObject({ id: providerId, packagePath: kindPath });
    expect(data.markdown).toContain("# Fixture Markdown Extraction");
  });

  it("attaches an extraction record to a workspace item when --attach-to is provided", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture("paper-search-extract-attached-");
    const relativeInput = path.join("inputs", "attached.txt");
    const attachedInput = path.join(root, relativeInput);
    await writeFile(attachedInput, "attached fixture source\n", "utf8");

    const result = await runExtractCommand(root, [
      "extract",
      relativeInput,
      "--provider",
      "fixture-markdown-extractor",
      "--attach-to",
      "item-123",
      "--policy",
      "workspace-safe",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    const data = expectExtractionData(result.envelope);
    expect(data.record.itemId).toBe("item-123");
    expect(data.record.source).toEqual({ kind: "path", path: attachedInput });
    expect(data.record.options).toMatchObject({
      policy: "workspace-safe",
      providerVersion: "1.0.0",
    });
    expect(data.markdown).toContain("Attachment: item-123");
    expect(data.markdown).toContain("Policy: workspace-safe");

    const savedRecord = JSON.parse(
      await readFile(path.join(workspaceRoot, "material", "extractions", `${data.record.id}.json`), "utf8"),
    ) as { itemId?: string; outputs?: { markdownPath?: string } };
    expect(savedRecord.itemId).toBe("item-123");
    await expect(readFile(path.join(workspaceRoot, savedRecord.outputs!.markdownPath!), "utf8")).resolves.toBe(
      data.markdown,
    );
  });

  it("returns a shared dry-run plan without writing extraction outputs or records", async () => {
    const { root, workspaceRoot, inputPath } = await createWorkspaceFixture("paper-search-extract-dry-run-");

    const result = await runExtractCommand(root, [
      "extract",
      inputPath,
      "--provider",
      "fixture-markdown-extractor",
      "--attach-to",
      "item-123",
      "--dry-run",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: true,
      capability: "extract",
      tool: "extract",
      planned: true,
      data: {
        selectedPolicy: "default",
        selectedProvider: {
          id: "fixture-markdown-extractor",
          kind: "material",
          capabilities: ["extract"],
        },
      },
    });
    expect(JSON.stringify(result.envelope.data)).toContain("<new-extraction-id>");
    await expect(stat(path.join(workspaceRoot, "material"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path-like --attach-to values before writing extraction outputs or records", async () => {
    const { root, workspaceRoot, inputPath } = await createWorkspaceFixture("paper-search-extract-invalid-attach-");

    const result = await runExtractCommand(root, [
      "extract",
      inputPath,
      "--provider",
      "fixture-markdown-extractor",
      "--attach-to",
      "../bad-item",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "extract",
      tool: "extract",
      data: null,
      errors: ["Invalid workspace item id: ../bad-item"],
    });
    await expect(stat(path.join(workspaceRoot, "material"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
