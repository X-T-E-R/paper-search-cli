import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const sandboxRoot = path.join(os.tmpdir(), `paper-search-vitest-${process.pid}-${randomUUID()}`);
process.env.HOME = path.join(sandboxRoot, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.APPDATA = path.join(sandboxRoot, "appdata");
process.env.LOCALAPPDATA = path.join(sandboxRoot, "localappdata");
process.env.XDG_CONFIG_HOME = path.join(sandboxRoot, "xdg-config");
process.env.PAPER_SEARCH_INSTALL_TEST_MODE = "1";
process.env.PAPER_SEARCH_TEST_DATA_ROOT = path.join(sandboxRoot, "data");

afterAll(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});
