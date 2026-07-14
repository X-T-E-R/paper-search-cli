import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstalledProviderConfigMetadata } from "../../src/config/providerDescriptors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("installed provider config descriptor discovery", () => {
  it("scans kind-separated custom and lifecycle roots plus the flat compatibility fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paper-search-config-descriptors-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAPER_SEARCH_INSTALL_TEST_MODE: "1",
      PAPER_SEARCH_TEST_DATA_ROOT: path.join(root, "data"),
    };
    const customRoot = path.join(root, "custom-providers");
    const searchTarget = path.join(customRoot, "search", "fixture-patent-session");
    await mkdir(searchTarget, { recursive: true });
    await cp(
      path.join("tests", "fixtures", "provider-packages", "fixture-patent-session", "manifest.json"),
      path.join(searchTarget, "manifest.json"),
    );

    const materialTarget = path.join(env.PAPER_SEARCH_TEST_DATA_ROOT!, "providers", "material", "fixture-extractor");
    await mkdir(materialTarget, { recursive: true });
    const materialManifest = JSON.parse(await readFile(
      path.join("tests", "fixtures", "material-provider-packages", "fixture-extractor", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    materialManifest.configSchema = {
      mode: { type: "string" },
      accessToken: { type: "secret", required: true },
    };
    await writeFile(path.join(materialTarget, "manifest.json"), `${JSON.stringify(materialManifest)}\n`);

    const flatTarget = path.join(customRoot, "flat-search");
    await mkdir(flatTarget, { recursive: true });
    const flatManifest = JSON.parse(await readFile(
      path.join("tests", "fixtures", "provider-packages", "fixture-academic", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    flatManifest.id = "flat-search";
    flatManifest.configSchema = { endpoint: { type: "string" } };
    await writeFile(path.join(flatTarget, "manifest.json"), `${JSON.stringify(flatManifest)}\n`);

    await expect(loadInstalledProviderConfigMetadata(customRoot, env)).resolves.toMatchObject({
      "platform.fixture-patent-session.password": "secret",
      "platform.fixture-patent-session.loginName": "non-secret",
      "platform.fixture-extractor.accessToken": "secret",
      "platform.fixture-extractor.mode": "non-secret",
      "platform.flat-search.endpoint": "non-secret",
    });
  });
});
