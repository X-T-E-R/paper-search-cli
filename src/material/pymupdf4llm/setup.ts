import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  PYMUPDF4LLM_LICENSE,
  PYMUPDF4LLM_VERSION,
  PYMUPDF_VERSION,
  resolvePyMuPDF4LLMHostPaths,
  type PyMuPDF4LLMHostPaths,
} from "./sidecar.js";

export interface PyMuPDF4LLMRuntimeStatus {
  ready: boolean;
  pythonVersion?: string;
  pymupdf4llmVersion?: string;
  pymupdfVersion?: string;
  reason?: string;
}

export interface PyMuPDF4LLMSetupPlan {
  runtimeRoot: string;
  pythonExecutable: string;
  requirementsLock: "requirements.lock.txt";
  pythonRequirement: "3.11";
  dependencies: {
    pymupdf4llm: string;
    pymupdf: string;
    tabulate: "0.10.0";
  };
  license: string;
  optionalLayoutExtensionInstalled: false;
  status: PyMuPDF4LLMRuntimeStatus;
}

export interface SetupPyMuPDF4LLMRuntimeOptions {
  apply: boolean;
  basePython?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SetupPyMuPDF4LLMRuntimeResult extends PyMuPDF4LLMSetupPlan {
  applied: boolean;
  alreadyReady: boolean;
}

const PROBE = "import json,platform,importlib.metadata as m;print(json.dumps({'python':platform.python_version(),'pymupdf4llm':m.version('pymupdf4llm'),'pymupdf':m.version('pymupdf'),'tabulate':m.version('tabulate')}))";

function cleanDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

function inspectPythonExecutable(executable: string): PyMuPDF4LLMRuntimeStatus {
  const probe = spawnSync(executable, ["-I", "-c", PROBE], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    env: {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONNOUSERSITE: "1",
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    },
  });
  if (probe.error || probe.status !== 0) {
    return {
      ready: false,
      reason: cleanDiagnostic(probe.stderr || probe.error?.message || "runtime probe failed"),
    };
  }
  try {
    const value = JSON.parse(probe.stdout) as Record<string, unknown>;
    const pythonVersion = String(value.python ?? "");
    const pymupdf4llmVersion = String(value.pymupdf4llm ?? "");
    const pymupdfVersion = String(value.pymupdf ?? "");
    const tabulateVersion = String(value.tabulate ?? "");
    const ready =
      /^3\.11(?:\.|$)/u.test(pythonVersion) &&
      pymupdf4llmVersion === PYMUPDF4LLM_VERSION &&
      pymupdfVersion === PYMUPDF_VERSION &&
      tabulateVersion === "0.10.0";
    return {
      ready,
      pythonVersion,
      pymupdf4llmVersion,
      pymupdfVersion,
      ...(ready ? {} : { reason: "The installed runtime does not match the pinned dependency set" }),
    };
  } catch {
    return { ready: false, reason: "The installed runtime returned an invalid probe response" };
  }
}

export async function inspectPyMuPDF4LLMRuntime(
  env: NodeJS.ProcessEnv = process.env,
  hostPaths: PyMuPDF4LLMHostPaths = resolvePyMuPDF4LLMHostPaths(env),
): Promise<PyMuPDF4LLMRuntimeStatus> {
  try {
    const info = await stat(hostPaths.pythonExecutable);
    if (!info.isFile()) return { ready: false, reason: "The pinned Python executable is not a file" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ready: false, reason: "The pinned runtime is not installed" };
    }
    return { ready: false, reason: "The pinned runtime could not be inspected" };
  }
  return inspectPythonExecutable(hostPaths.pythonExecutable);
}

export async function planPyMuPDF4LLMRuntimeSetup(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PyMuPDF4LLMSetupPlan> {
  const hostPaths = resolvePyMuPDF4LLMHostPaths(env);
  return {
    runtimeRoot: hostPaths.runtimeRoot,
    pythonExecutable: hostPaths.pythonExecutable,
    requirementsLock: "requirements.lock.txt",
    pythonRequirement: "3.11",
    dependencies: {
      pymupdf4llm: PYMUPDF4LLM_VERSION,
      pymupdf: PYMUPDF_VERSION,
      tabulate: "0.10.0",
    },
    license: PYMUPDF4LLM_LICENSE,
    optionalLayoutExtensionInstalled: false,
    status: await inspectPyMuPDF4LLMRuntime(env, hostPaths),
  };
}

function requireAbsoluteBasePython(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(
      "--python is required for first-time setup and must name an absolute Python 3.11 executable",
    );
  }
  if (!path.isAbsolute(value)) {
    throw new Error("--python must be an absolute Python 3.11 executable path");
  }
  return path.normalize(value);
}

function assertBasePython311(executable: string): void {
  const probe = spawnSync(
    executable,
    ["-I", "-c", "import json,sys;print(json.dumps({'major':sys.version_info.major,'minor':sys.version_info.minor}))"],
    {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error("The selected --python executable could not be started");
  }
  try {
    const version = JSON.parse(probe.stdout) as { major?: unknown; minor?: unknown };
    if (version.major !== 3 || version.minor !== 11) throw new Error("version mismatch");
  } catch {
    throw new Error("The selected --python executable must be Python 3.11");
  }
}

function runSetupStep(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(executable, [...args], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed; inspect the local setup command diagnostics`);
  }
}

export async function setupPyMuPDF4LLMRuntime(
  options: SetupPyMuPDF4LLMRuntimeOptions,
): Promise<SetupPyMuPDF4LLMRuntimeResult> {
  const env = options.env ?? process.env;
  const plan = await planPyMuPDF4LLMRuntimeSetup(env);
  if (!options.apply) return { ...plan, applied: false, alreadyReady: plan.status.ready };
  if (plan.status.ready) return { ...plan, applied: false, alreadyReady: true };

  const hostPaths = resolvePyMuPDF4LLMHostPaths(env);
  const basePython = requireAbsoluteBasePython(options.basePython);
  assertBasePython311(basePython);
  await readFile(hostPaths.requirementsPath, "utf8").catch(() => {
    throw new Error("The packaged PyMuPDF4LLM requirements lock is unavailable");
  });
  const runtimePythonRoot = path.join(hostPaths.runtimeRoot, "python");
  try {
    await stat(runtimePythonRoot);
    throw new Error(
      "The existing PyMuPDF4LLM runtime is incomplete; remove its version directory before reinstalling",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(hostPaths.runtimeRoot, { recursive: true });
  let created = false;
  try {
    // Treat venv creation as owned as soon as it starts: Python can leave a
    // partial directory when creation fails, and a retry must not require
    // manual cleanup.
    created = true;
    runSetupStep(
      basePython,
      ["-m", "venv", runtimePythonRoot],
      hostPaths.runtimeRoot,
      env,
      "Python virtual environment creation",
    );
    runSetupStep(
      hostPaths.pythonExecutable,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-deps",
        "--only-binary=:all:",
        "--requirement",
        hostPaths.requirementsPath,
      ],
      hostPaths.runtimeRoot,
      env,
      "Pinned PyMuPDF4LLM dependency installation",
    );
    const status = await inspectPyMuPDF4LLMRuntime(env, hostPaths);
    if (!status.ready) throw new Error(status.reason ?? "Pinned runtime verification failed");
    return {
      ...(await planPyMuPDF4LLMRuntimeSetup(env)),
      applied: true,
      alreadyReady: false,
    };
  } catch (error) {
    if (created) await rm(runtimePythonRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
