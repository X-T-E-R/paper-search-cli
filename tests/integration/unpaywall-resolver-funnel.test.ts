import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../../src/program.js";
import { readArtifactRecord } from "../../src/material/artifactStore.js";
import type { ArtifactDownloadData } from "../../src/material/artifactDownload.js";
import { isResultEnvelope, type ResultEnvelope } from "../../src/surface/resultEnvelope.js";
import { resolveDistributableMaterialPackageDir } from "../helpers/distributableMaterialProviders.js";

const tempDirs: string[] = [];
const downloaderFixture = path.resolve("tests", "fixtures", "material-downloaders", "fixture-artifact-downloader");

let unpaywallPackageDir = "";

beforeAll(async () => {
  unpaywallPackageDir = await resolveDistributableMaterialPackageDir("unpaywall");
});

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "paper-search-unpaywall-install-"));
  tempDirs.push(dir);
  await cp(downloaderFixture, path.join(dir, "fixture-artifact-downloader"), { recursive: true });
  await cp(unpaywallPackageDir, path.join(dir, "unpaywall"), { recursive: true });
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
      "[platform.unpaywall]",
      'email = "offline-unpaywall@research.tools"',
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

function stubUnpaywallFetch(doi: string, pdfUrl: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.unpaywall.org")) {
        expect(url).toContain(encodeURIComponent(doi));
        return new Response(
          JSON.stringify({
            doi,
            is_oa: true,
            best_oa_location: {
              url_for_pdf: pdfUrl,
              license: "cc-by",
              version: "publishedVersion",
              host_type: "publisher",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected live fetch during offline unpaywall funnel test: ${url}`);
    }),
  );
}

describe("unpaywall distributable resolver acquire funnel", () => {
  it("downloads through unpaywall resolver candidates for a DOI input with stubbed Unpaywall HTTP", async () => {
    const installDir = await prepareInstallDir();
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-unpaywall-doi-"));
    tempDirs.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await writeProjectConfig(root, workspaceRoot, installDir);

    const doi = "10.1234/unpaywall-offline-funnel";
    const candidateUrl = "https://example.test/unpaywall-offline-candidate.pdf";
    stubUnpaywallFetch(doi, candidateUrl);

    const result = await runArtifactCommand(root, [
      "artifact",
      "download",
      doi,
      "--resolver",
      "unpaywall",
      "--policy",
      "unpaywall-offline",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.envelope.ok).toBe(true);
    const data = result.envelope.data as ArtifactDownloadData;
    expect(data.input).toMatchObject({ kind: "identifier", value: doi });
    expect(data.record.provenance).toMatchObject({
      resolverProviderId: "unpaywall",
      resolverSource: "unpaywall",
      providerId: "fixture-artifact-downloader",
    });
    expect(data.record.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "artifact-resolver", ok: true, providerId: "unpaywall" }),
        expect.objectContaining({ tier: "artifact-download-candidate", ok: true }),
      ]),
    );
    expect(data.record.remoteUrl).toBe(candidateUrl);
    await expect(readArtifactRecord(workspaceRoot, data.record.id)).resolves.toBeDefined();
  });
});
