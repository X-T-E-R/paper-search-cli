import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const sandboxRoot = path.join(os.tmpdir(), `paper-search-vitest-${process.pid}-${randomUUID()}`);
process.env.APPDATA = path.join(sandboxRoot, "appdata");
process.env.LOCALAPPDATA = path.join(sandboxRoot, "localappdata");
process.env.XDG_CONFIG_HOME = path.join(sandboxRoot, "xdg-config");

afterAll(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});
