import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import type { ArtifactDownloadData } from "../../src/material/artifactDownload.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { addResourceToWorkspace } from "../../src/workspace/store.js";

const tempDirs: string[] = [];
const downloaderFixture = path.resolve("tests", "fixtures", "material-downloaders", "fixture-artifact-downloader");
const resolverFixture = path.resolve("tests", "fixtures", "material-resolvers", "fixture-artifact-resolver");
const extractorFixture = path.resolve("tests", "fixtures", "material-extractors", "fixture-markdown-extractor");

afterEach(async () => {
  vi.unstubAllGlobals();
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function tomlPath(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

async function prepareInstallDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paper-search-acquire-install-"));
  tempDirs.push(dir);
  await cp(downloaderFixture, path.join(dir, "fixture-artifact-downloader"), { recursive: true });
  await cp(resolverFixture, path.join(dir, "fixture-artifact-resolver"), { recursive: true });
  await cp(extractorFixture, path.join(dir, "fixture-markdown-extractor"), { recursive: true });
  return dir;
}

async function writeProjectConfig(root: string, workspaceRoot: string, installDir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
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
      "[platform.fixture-artifact-downloader]",
      'mode = "integration"',
      "",
      "[platform.fixture-artifact-resolver]",
      'mode = "multi"',
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

async function createWorkspace(prefix: string, installDir: string): Promise<{ root: string; workspaceRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await writeProjectConfig(root, workspaceRoot, installDir);
  return { root, workspaceRoot };
}

describe("artifact resolver acquire funnel", () => {
  it("downloads through resolver candidates for a DOI input", async () => {
    const installDir = await prepareInstallDir();
    const { root, workspaceRoot } = await createWorkspace("paper-search-resolver-doi-", installDir);
    const fetchMock = vi.fn(async () => {
      throw new Error("resolver funnel must not use live fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const doi = "10.1234/resolver-funnel";
    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      doi,
      "--policy",
      "resolver-funnel",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(true);
    const data = result.envelope.data as ArtifactDownloadData;
    expect(data.input).toMatchObject({ kind: "identifier", value: doi });
    expect(data.record.provenance).toMatchObject({
      resolverProviderId: "fixture-artifact-resolver",
      resolverSource: "fixture-resolver",
      providerId: "fixture-artifact-downloader",
    });
    expect(data.record.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "artifact-resolver", ok: true }),
        expect.objectContaining({ tier: "artifact-download-candidate", ok: true }),
      ]),
    );
    expect(data.record.remoteUrl).toContain("10-1234-resolver-funnel-primary.pdf");
    await expect(readArtifactRecord(workspaceRoot, data.record.id)).resolves.toBeDefined();
  });

  it("rejects HTTP-200 challenge HTML and continues to the next resolver candidate", async () => {
    const installDir = await prepareInstallDir();
    await writeFile(
      path.join(installDir, "fixture-artifact-downloader", "provider.js"),
      [
        "globalThis.__material_provider_exports = {",
        "  createProvider() {",
        "    return {",
        "      async download(input) {",
        "        if (input.url.includes('-primary.pdf')) {",
        "          return {",
        "            kind: 'html',",
        "            filename: 'challenge.html',",
        "            contentType: 'text/html; charset=utf-8',",
        "            remoteUrl: input.url,",
        "            status: 200,",
        "            text: '<head><title>Radware Bot Manager Captcha</title></head><body>Human verification</body>'",
        "          };",
        "        }",
        "        return {",
        "          kind: 'pdf',",
        "          filename: 'paper.pdf',",
        "          contentType: 'application/pdf',",
        "          remoteUrl: input.url,",
        "          status: 200,",
        "          text: '%PDF-1.7 valid fallback'",
        "        };",
        "      }",
        "    };",
        "  }",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const { root, workspaceRoot } = await createWorkspace("paper-search-resolver-challenge-", installDir);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "10.1234/challenge-fallback",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(true);
    const data = result.envelope.data as ArtifactDownloadData;
    expect(data.record.remoteUrl).toContain("10-1234-challenge-fallback-fallback.pdf");
    expect(data.record.kind).toBe("pdf");
    expect(data.record.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tier: "artifact-download-candidate",
        ok: false,
        status: 200,
        message: expect.stringContaining("radware bot manager captcha"),
      }),
      expect.objectContaining({ tier: "artifact-download-candidate", ok: true, status: 200 }),
    ]));
    await expect(readArtifactRecord(workspaceRoot, data.record.id)).resolves.toMatchObject({
      id: data.record.id,
      kind: "pdf",
      remoteUrl: data.record.remoteUrl,
    });
  });

  it("returns a typed failure envelope when the resolver yields no candidates", async () => {
    const installDir = await prepareInstallDir();
    const { root } = await createWorkspace("paper-search-resolver-empty-", installDir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${tomlPath(installDir)}"`,
        "",
        "[workspace]",
        `root = "${tomlPath(path.join(root, "workspace"))}"`,
        'defaultCollection = "Inbox"',
        "",
        "[platform.fixture-artifact-resolver]",
        'mode = "empty"',
        "",
      ].join("\n"),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn());

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "10.1234/empty-candidates",
      "--json",
    ]);

    expect(result.envelope).toMatchObject({
      ok: false,
      capability: "acquire",
      tool: "artifact_download",
      diagnostics: {
        failureKind: "no_candidates",
        attempts: [expect.objectContaining({ tier: "artifact-resolver", ok: true })],
      },
    });
  });

  it("fails with no_resolver when only a downloader is installed", async () => {
    const { root } = await createWorkspace(
      "paper-search-resolver-missing-",
      path.resolve("tests", "fixtures", "material-downloaders"),
    );
    vi.stubGlobal("fetch", vi.fn());

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "10.1234/no-resolver",
      "--json",
    ]);

    expect(result.envelope).toMatchObject({
      ok: false,
      diagnostics: { failureKind: "no_resolver" },
    });
  });

  it("maps resolver provider errors to diagnostic attempts", async () => {
    const installDir = await prepareInstallDir();
    const { root } = await createWorkspace("paper-search-resolver-error-", installDir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(root, "paper-search.toml"),
      [
        "[providers]",
        `installDir = "${tomlPath(installDir)}"`,
        "",
        "[workspace]",
        `root = "${tomlPath(path.join(root, "workspace"))}"`,
        'defaultCollection = "Inbox"',
        "",
        "[platform.fixture-artifact-resolver]",
        'mode = "error"',
        "",
      ].join("\n"),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn());

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "10.1234/resolver-error",
      "--json",
    ]);

    expect(result.envelope).toMatchObject({
      ok: false,
      diagnostics: {
        failureKind: "resolver_error",
        attempts: [expect.objectContaining({ tier: "artifact-resolver", ok: false })],
      },
    });
  });

  it("lists resolver steps in dry-run plans for DOI input", async () => {
    const installDir = await prepareInstallDir();
    const { root } = await createWorkspace("paper-search-resolver-plan-", installDir);
    vi.stubGlobal("fetch", vi.fn());

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      "10.1234/resolver-plan",
      "--dry-run",
      "--json",
    ]);

    expect(result.envelope).toMatchObject({ ok: true, planned: true });
    const steps = JSON.stringify(result.envelope.data);
    expect(steps).toContain("load-resolver");
    expect(steps).toContain("fixture-artifact-resolver");
    expect(steps).toContain("run-resolver");
  });

  it("plans DOI material ingest with resolver steps listed", async () => {
    const installDir = await prepareInstallDir();
    const { root, workspaceRoot } = await createWorkspace("paper-search-resolver-ingest-plan-", installDir);
    vi.stubGlobal("fetch", vi.fn());

    const result = await runArtifactCommand(root, [
      "material",
      "ingest",
      "10.1234/ingest-plan",
      "--dry-run",
      "--json",
    ]);

    expect(result.envelope).toMatchObject({
      ok: true,
      capability: "orchestrate",
      tool: "material_ingest",
      planned: true,
    });
    const serialized = JSON.stringify(result.envelope.data);
    expect(serialized).toContain("artifact.load-resolver");
    expect(serialized).toContain("artifact.run-resolver");
    expect(serialized).toContain("fixture-artifact-resolver");
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(workspaceRoot, "material"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves workspace items by DOI when no artifact URL is present", async () => {
    const installDir = await prepareInstallDir();
    const { root, workspaceRoot } = await createWorkspace("paper-search-resolver-item-", installDir);
    vi.stubGlobal("fetch", vi.fn());

    const addResult = await addResourceToWorkspace(workspaceRoot, {
      item: {
        itemType: "journalArticle",
        title: "DOI-only Item",
        DOI: "10.1234/workspace-doi-only",
      },
      defaultCollectionPath: "Inbox",
    });

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      addResult.record.id,
      "--json",
    ]);

    expect(result.envelope.ok).toBe(true);
    const data = result.envelope.data as ArtifactDownloadData;
    expect(data.record.provenance.resolverProviderId).toBe("fixture-artifact-resolver");
  });
});
