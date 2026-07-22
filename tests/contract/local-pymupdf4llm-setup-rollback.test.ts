import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hostPaths: undefined as
    | {
        runtimeRoot: string;
        pythonExecutable: string;
        adapterPath: string;
        requirementsPath: string;
        tempRoot: string;
      }
    | undefined,
}));

vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  return {
    spawnSync(_executable: string, args: readonly string[]) {
      if (args[0] === "-I") {
        return {
          status: 0,
          stdout: '{"major":3,"minor":11}\n',
          stderr: "",
        };
      }
      if (args[0] === "-m" && args[1] === "venv") {
        fs.mkdirSync(String(args[2]), { recursive: true });
        return {
          status: 1,
          stdout: "",
          stderr: "simulated partial venv failure",
        };
      }
      throw new Error(`Unexpected command arguments: ${args.join(" ")}`);
    },
  };
});

vi.mock("../../src/material/pymupdf4llm/sidecar.js", () => ({
  PYMUPDF4LLM_LICENSE:
    "Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License",
  PYMUPDF4LLM_VERSION: "0.3.4",
  PYMUPDF_VERSION: "1.27.2.3",
  resolvePyMuPDF4LLMHostPaths() {
    if (!state.hostPaths) throw new Error("test host paths are not initialized");
    return state.hostPaths;
  },
}));

import { setupPyMuPDF4LLMRuntime } from "../../src/material/pymupdf4llm/setup.js";

const tempDirs: string[] = [];

afterEach(async () => {
  state.hostPaths = undefined;
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("local PyMuPDF4LLM runtime setup rollback", () => {
  it("removes a partially created virtual environment when venv creation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-pymupdf4llm-rollback-"));
    tempDirs.push(root);
    const runtimeRoot = path.join(root, "runtime");
    const runtimePythonRoot = path.join(runtimeRoot, "python");
    const requirementsPath = path.join(root, "requirements.lock.txt");
    await writeFile(requirementsPath, "pymupdf4llm==0.3.4\n", "utf8");
    state.hostPaths = {
      runtimeRoot,
      pythonExecutable: path.join(runtimePythonRoot, "Scripts", "python.exe"),
      adapterPath: path.join(root, "adapter.py"),
      requirementsPath,
      tempRoot: path.join(runtimeRoot, "tmp"),
    };

    await expect(
      setupPyMuPDF4LLMRuntime({
        apply: true,
        basePython: path.join(root, "python311.exe"),
        env: {},
      }),
    ).rejects.toThrow("Python virtual environment creation failed");

    await expect(
      import("node:fs/promises").then(({ stat }) => stat(runtimePythonRoot)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
