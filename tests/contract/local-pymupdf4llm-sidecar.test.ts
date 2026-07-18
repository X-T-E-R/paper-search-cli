import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMaterialProviderPackage } from "../../src/material/package/load.js";
import {
  createMaterialRuntimeContext,
  MaterialRuntimePermissionError,
} from "../../src/material/runtime/createContext.js";
import { invokeMaterialProviderFactoryInNode } from "../../src/material/runtime/invokeNodeFactory.js";
import {
  PyMuPDF4LLMSidecarError,
  runPyMuPDF4LLMSidecar,
  type PyMuPDF4LLMHostPaths,
  type PyMuPDF4LLMMetadata,
  type RunPyMuPDF4LLMSidecarOptions,
} from "../../src/material/pymupdf4llm/sidecar.js";
import { planPyMuPDF4LLMRuntimeSetup } from "../../src/material/pymupdf4llm/setup.js";
import type { MaterialProviderManifest } from "../../src/material/types.js";

const tempDirs: string[] = [];
const packagePath = path.resolve(
  "tests",
  "fixtures",
  "material-provider-packages",
  "local-pymupdf4llm",
);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pymupdf4llm-test-"));
  tempDirs.push(root);
  return root;
}

function metadata(): PyMuPDF4LLMMetadata {
  return {
    parser: {
      name: "pymupdf4llm",
      version: "0.3.4",
      pymupdfVersion: "1.27.2.3",
      mode: "official-legacy-markdown",
      license: "fixture",
    },
    pageCount: 2,
    ocr: false,
    images: "disabled",
    tableStrategy: "lines_strict",
    warnings: [],
    elapsedMs: 5,
  };
}

async function nodeHostPaths(root: string, adapterSource: string): Promise<{
  hostPaths: PyMuPDF4LLMHostPaths;
  pdfPath: string;
}> {
  const adapterPath = path.join(root, "adapter.mjs");
  const pdfPath = path.join(root, "input.pdf");
  await writeFile(adapterPath, adapterSource, "utf8");
  await writeFile(pdfPath, "%PDF-1.7\nfixture\n", "utf8");
  return {
    hostPaths: {
      runtimeRoot: path.dirname(process.execPath),
      pythonExecutable: process.execPath,
      adapterPath,
      requirementsPath: path.join(root, "requirements.lock.txt"),
      tempRoot: path.join(root, "tmp"),
    },
    pdfPath,
  };
}

function jsonAdapter(body: string): string {
  return [
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(chunk)=>{input+=chunk});",
    `process.stdin.on('end',()=>{${body}});`,
  ].join("\n");
}

describe("local PyMuPDF4LLM sidecar boundary", () => {
  it("plans an exact Python 3.11 dependency set without creating a runtime or exposing checkout paths", async () => {
    const root = await fixtureRoot();
    const home = path.join(root, "paper-search-home");
    const plan = await planPyMuPDF4LLMRuntimeSetup({ PAPER_SEARCH_HOME: home });
    expect(plan).toMatchObject({
      runtimeRoot: path.join(home, "runtimes", "pymupdf4llm", "0.3.4"),
      requirementsLock: "requirements.lock.txt",
      pythonRequirement: "3.11",
      dependencies: {
        pymupdf4llm: "0.3.4",
        pymupdf: "1.27.2.3",
        tabulate: "0.10.0",
      },
      optionalLayoutExtensionInstalled: false,
      status: { ready: false },
    });
    expect(JSON.stringify(plan)).not.toContain(process.cwd());
  });

  it("runs one fixed executable and adapter with JSON stdin, no extra args, and an allowlisted environment", async () => {
    const root = await fixtureRoot();
    const { hostPaths, pdfPath } = await nodeHostPaths(root, jsonAdapter(`
      const request=JSON.parse(input);
      const markdown=JSON.stringify({
        argv:process.argv.slice(2),
        requestKeys:Object.keys(request.input).sort(),
        nonEmptyEnvKeys:Object.keys(process.env).filter((key)=>process.env[key] !== '').sort(),
        inheritedSecret:process.env.SIDECAR_SENTINEL ?? null
      });
      process.stdout.write(JSON.stringify({
        protocol:'paper-search.pymupdf4llm',version:1,ok:true,markdown,
        metadata:${JSON.stringify(metadata())}
      }));
    `));
    const result = await runPyMuPDF4LLMSidecar({
      pdfPath,
      timeoutMs: 5_000,
      hostPaths,
      env: {
        ...process.env,
        SIDECAR_SENTINEL: "must-not-cross",
      },
    });
    const observed = JSON.parse(result.markdown) as {
      argv: string[];
      requestKeys: string[];
      nonEmptyEnvKeys: string[];
      inheritedSecret: string | null;
    };
    expect(observed.argv).toEqual([]);
    expect(observed.requestKeys).toEqual(["ocr", "path"]);
    expect(observed.inheritedSecret === null || observed.inheritedSecret === "").toBe(true);
    expect(observed.nonEmptyEnvKeys).not.toContain("SIDECAR_SENTINEL");
    expect(observed.nonEmptyEnvKeys).not.toContain("PATH");
    expect(observed.nonEmptyEnvKeys).toEqual(expect.arrayContaining([
      "ALL_PROXY",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "PIP_NO_INDEX",
      "PYTHONNOUSERSITE",
    ]));
  });

  it("enforces timeout, output, empty Markdown, missing runtime, and redacted crash errors", async () => {
    const timeoutRoot = await fixtureRoot();
    const timeoutFixture = await nodeHostPaths(
      timeoutRoot,
      jsonAdapter("setInterval(()=>{},1000);"),
    );
    await expect(runPyMuPDF4LLMSidecar({
      pdfPath: timeoutFixture.pdfPath,
      timeoutMs: 1_000,
      hostPaths: timeoutFixture.hostPaths,
    })).rejects.toMatchObject({ code: "PARSER_TIMEOUT" });

    const emptyRoot = await fixtureRoot();
    const emptyFixture = await nodeHostPaths(emptyRoot, jsonAdapter(`
      process.stdout.write(JSON.stringify({
        protocol:'paper-search.pymupdf4llm',version:1,ok:true,markdown:'   ',
        metadata:${JSON.stringify(metadata())}
      }));
    `));
    await expect(runPyMuPDF4LLMSidecar({
      pdfPath: emptyFixture.pdfPath,
      hostPaths: emptyFixture.hostPaths,
    })).rejects.toMatchObject({ code: "EMPTY_MARKDOWN" });

    const outputRoot = await fixtureRoot();
    const outputFixture = await nodeHostPaths(outputRoot, jsonAdapter(`
      process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
    `));
    await expect(runPyMuPDF4LLMSidecar({
      pdfPath: outputFixture.pdfPath,
      hostPaths: outputFixture.hostPaths,
    })).rejects.toMatchObject({ code: "SIDECAR_OUTPUT_LIMIT" });

    const missingRoot = await fixtureRoot();
    const missingFixture = await nodeHostPaths(missingRoot, "");
    missingFixture.hostPaths.runtimeRoot = missingRoot;
    missingFixture.hostPaths.pythonExecutable = path.join(missingRoot, "missing-python");
    await expect(runPyMuPDF4LLMSidecar({
      pdfPath: missingFixture.pdfPath,
      hostPaths: missingFixture.hostPaths,
    })).rejects.toMatchObject({ code: "DEPENDENCY_MISSING" });

    const crashRoot = await fixtureRoot();
    const secret = "super-secret-token";
    const crashFixture = await nodeHostPaths(
      crashRoot,
      `process.stderr.write('${secret} C:\\\\private\\\\repo\\\\paper.pdf');process.exit(2);`,
    );
    const failure = await runPyMuPDF4LLMSidecar({
      pdfPath: crashFixture.pdfPath,
      hostPaths: crashFixture.hostPaths,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PyMuPDF4LLMSidecarError);
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain("private");
    expect(failure).toMatchObject({ code: "EXTRACTION_FAILED" });
  }, 15_000);

  it("rejects non-PDF files and forwards typed adapter failures without path disclosure", async () => {
    const root = await fixtureRoot();
    const fixture = await nodeHostPaths(root, jsonAdapter(`
      process.stdout.write(JSON.stringify({
        protocol:'paper-search.pymupdf4llm',version:1,ok:false,
        error:{code:'ENCRYPTED_PDF',message:'The PDF requires a password and cannot be extracted'}
      }));
    `));
    const invalidPath = path.join(root, "not-a-pdf.txt");
    await writeFile(invalidPath, "not pdf", "utf8");
    await expect(runPyMuPDF4LLMSidecar({
      pdfPath: invalidPath,
      hostPaths: fixture.hostPaths,
    })).rejects.toMatchObject({ code: "INVALID_PDF" });
    const encrypted = await runPyMuPDF4LLMSidecar({
      pdfPath: fixture.pdfPath,
      hostPaths: fixture.hostPaths,
    }).catch((error: unknown) => error);
    expect(encrypted).toMatchObject({ code: "ENCRYPTED_PDF" });
    expect(String(encrypted)).not.toContain(fixture.pdfPath);
  });
});

describe("local PyMuPDF4LLM provider contract", () => {
  it("uses only the host-authorized PDF and returns parser metadata through the provider VM", async () => {
    const root = await fixtureRoot();
    const pdfPath = path.join(root, "managed.pdf");
    await writeFile(pdfPath, "%PDF-1.7\nfixture\n", "utf8");
    const loaded = await loadMaterialProviderPackage(packagePath);
    const runner = vi.fn(async (_options: RunPyMuPDF4LLMSidecarOptions) => ({
      markdown: "# Extracted\n",
      metadata: metadata(),
    }));
    const runtimeContext = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      providerConfig: { ocr: false, timeoutMs: 12_000 },
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      authorizedPdfPath: pdfPath,
      pymupdf4llmRunner: runner,
    });
    const provider = await invokeMaterialProviderFactoryInNode(
      loaded.bundleCode,
      loaded.manifest,
      runtimeContext,
    );
    const result = await provider.provider.extract!({
      source: { kind: "path", path: path.join(root, "provider-controlled.pdf") },
    }) as { markdown: string; metadata: PyMuPDF4LLMMetadata; message: string };
    expect(result).toMatchObject({
      markdown: "# Extracted\n",
      metadata: { pageCount: 2, images: "disabled" },
      message: "Local PyMuPDF4LLM extracted 2 PDF page(s).",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      pdfPath,
      ocr: false,
      timeoutMs: 12_000,
    }));
    expect(runner.mock.calls[0]?.[0]).not.toHaveProperty("args");
  });

  it("rejects provider attempts to supply paths, args, or environment and denies unrelated providers", async () => {
    const root = await fixtureRoot();
    const pdfPath = path.join(root, "managed.pdf");
    await writeFile(pdfPath, "%PDF-1.7\nfixture\n", "utf8");
    const loaded = await loadMaterialProviderPackage(packagePath);
    const context = createMaterialRuntimeContext({
      manifest: loaded.manifest,
      cacheRoot: path.join(root, "cache"),
      workspaceRoot: path.join(root, "workspace"),
      authorizedPdfPath: pdfPath,
      pymupdf4llmRunner: vi.fn(),
    });
    await expect(context.sidecar.pymupdf4llm.toMarkdown({
      path: path.join(root, "other.pdf"),
    } as never)).rejects.toThrow("Unsupported PyMuPDF4LLM option: path");
    await expect(context.sidecar.pymupdf4llm.toMarkdown({ args: ["--unsafe"] } as never))
      .rejects.toThrow("Unsupported PyMuPDF4LLM option: args");
    await expect(context.sidecar.pymupdf4llm.toMarkdown({ env: { TOKEN: "secret" } } as never))
      .rejects.toThrow("Unsupported PyMuPDF4LLM option: env");

    const unrelated: MaterialProviderManifest = {
      ...loaded.manifest,
      id: "unrelated-extractor",
    };
    const denied = createMaterialRuntimeContext({
      manifest: unrelated,
      cacheRoot: path.join(root, "other-cache"),
      workspaceRoot: path.join(root, "other-workspace"),
      authorizedPdfPath: pdfPath,
      pymupdf4llmRunner: vi.fn(),
    });
    await expect(denied.sidecar.pymupdf4llm.toMarkdown()).rejects.toThrow(
      MaterialRuntimePermissionError,
    );
  });
});
