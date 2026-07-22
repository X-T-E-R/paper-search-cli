import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfigFiles } from "../../src/config/load.js";
import { resolveConfigFragmentDirectory } from "../../src/config/paths.js";

const tempDirs: string[] = [];
let originalPaperSearchHome: string | undefined;

async function createRoot(prefix: string): Promise<{
  root: string;
  appRoot: string;
  configPath: string;
  projectRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const appRoot = path.join(root, "paper-search-home");
  const projectRoot = path.join(root, "project");
  await mkdir(appRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  originalPaperSearchHome = process.env.PAPER_SEARCH_HOME;
  process.env.PAPER_SEARCH_HOME = appRoot;
  return {
    root,
    appRoot,
    configPath: path.join(appRoot, "config.toml"),
    projectRoot,
  };
}

afterEach(async () => {
  if (originalPaperSearchHome === undefined) delete process.env.PAPER_SEARCH_HOME;
  else process.env.PAPER_SEARCH_HOME = originalPaperSearchHome;
  originalPaperSearchHome = undefined;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("configuration fragments", () => {
  it("derives one adjacent fragment directory from each main config file", () => {
    expect(resolveConfigFragmentDirectory(path.join("root", "config.toml"))).toBe(
      path.join("root", "config.d"),
    );
    expect(resolveConfigFragmentDirectory(path.join("root", "paper-search.toml"))).toBe(
      path.join("root", "paper-search.d"),
    );
    expect(resolveConfigFragmentDirectory(path.join("root", ".paper-search.toml"))).toBe(
      path.join("root", ".paper-search.d"),
    );
    expect(resolveConfigFragmentDirectory(path.join("root", "override.toml"))).toBe(
      path.join("root", "override.d"),
    );
  });

  it("loads user, project, and explicit fragments after each main file", async () => {
    const { appRoot, configPath, projectRoot, root } = await createRoot(
      "paper-search-config-fragment-paths-",
    );
    const userFragments = path.join(appRoot, "config.d");
    const projectFragments = path.join(projectRoot, "paper-search.d");
    const explicitRoot = path.join(root, "explicit");
    const explicitFragments = path.join(explicitRoot, "config.d");
    await Promise.all([
      mkdir(userFragments, { recursive: true }),
      mkdir(projectFragments, { recursive: true }),
      mkdir(explicitFragments, { recursive: true }),
    ]);

    await writeFile(configPath, "schemaVersion = 1\n[output]\nlocale = \"user-main\"\n");
    await writeFile(path.join(userFragments, "10-user.toml"), "[output]\nlocale = \"user-fragment\"\n");
    await writeFile(path.join(projectRoot, "paper-search.toml"), "[output]\nlocale = \"project-main\"\n");
    await writeFile(path.join(projectFragments, "10-project.toml"), "[output]\nlocale = \"project-fragment\"\n");
    await writeFile(path.join(explicitRoot, "config.toml"), "[output]\nlocale = \"explicit-main\"\n");
    await writeFile(path.join(explicitFragments, "10-explicit.toml"), "[output]\nlocale = \"explicit-fragment\"\n");

    const config = await loadConfig({ cwd: projectRoot, explicitConfigPath: explicitRoot });
    expect(config.output.locale).toBe("explicit-fragment");
    expect(config.meta.loadedFiles).toEqual([
      configPath,
      path.join(userFragments, "10-user.toml"),
      path.join(projectRoot, "paper-search.toml"),
      path.join(projectFragments, "10-project.toml"),
      path.join(explicitRoot, "config.toml"),
      path.join(explicitFragments, "10-explicit.toml"),
    ]);

    const validated = await validateConfigFiles({ cwd: projectRoot, explicitConfigPath: explicitRoot });
    expect(validated.filter((entry) => entry.kind.endsWith("fragment")).map((entry) => entry.kind)).toEqual([
      "config-fragment",
      "project-fragment",
      "explicit-fragment",
    ]);
  });

  it("loads fragments lexically and replaces named definitions atomically", async () => {
    const { appRoot, configPath, projectRoot } = await createRoot(
      "paper-search-config-fragment-order-",
    );
    const fragments = path.join(appRoot, "config.d");
    await mkdir(fragments, { recursive: true });
    await mkdir(path.join(fragments, "nested"), { recursive: true });
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[output]",
      "prettyJson = false",
      'locale = "main"',
      "[search]",
      'defaultAcademicPresets = ["general", "my-general"]',
      "[search.classifications.lab-preferred]",
      'sources = ["crossref"]',
      "[search.presets.my-general]",
      'extends = ["general"]',
      'include = ["source:crossref"]',
      'exclude = ["source:semantic"]',
      "",
    ].join("\n"));
    await writeFile(path.join(fragments, "20-final.toml"), [
      "[output]",
      'locale = "final"',
      "[search.presets.my-general]",
      'include = ["source:pubmed"]',
      "",
    ].join("\n"));
    await writeFile(path.join(fragments, "10-middle.toml"), [
      "[search]",
      'defaultAcademicPresets = ["my-general"]',
      "[search.classifications.lab-preferred]",
      'sources = ["openalex"]',
      "[search.presets.my-general]",
      'extends = ["general"]',
      'include = ["source:openalex"]',
      "",
    ].join("\n"));
    await writeFile(
      path.join(fragments, "nested", "00-not-recursive.toml"),
      "[output]\nlocale = \"nested\"\n",
    );

    const config = await loadConfig({ cwd: projectRoot });
    expect(config.search.defaultAcademicPresets).toEqual(["my-general"]);
    expect(config.search.classifications["lab-preferred"]).toEqual({ sources: ["openalex"] });
    expect(config.search.presets["my-general"]).toEqual({
      extends: [],
      include: ["source:pubmed"],
      exclude: [],
    });
    expect(config.output).toMatchObject({ locale: "final", prettyJson: false });
    expect(config.meta.loadedFiles.slice(0, 3)).toEqual([
      configPath,
      path.join(fragments, "10-middle.toml"),
      path.join(fragments, "20-final.toml"),
    ]);
    expect(config.meta.origins?.["search.presets.my-general.include"]).toEqual({
      kind: "user",
      source: path.join(fragments, "20-final.toml"),
    });
    expect(config.meta.origins?.["search.presets.my-general.extends"]).toBeUndefined();
    expect(config.meta.origins?.["search.presets.my-general.exclude"]).toBeUndefined();
  });

  it("keeps split and single-file configuration equivalent, including relative paths", async () => {
    const { appRoot, configPath, projectRoot } = await createRoot(
      "paper-search-config-fragment-equivalence-",
    );
    const complete = [
      "schemaVersion = 1",
      "[workspace]",
      'root = "./workspace"',
      "[search]",
      'defaultAcademicPresets = ["my-general"]',
      "[search.classifications.lab-preferred]",
      'sources = ["crossref", "openalex"]',
      "[search.presets.my-general]",
      'extends = ["general"]',
      'include = ["tag:lab-preferred", "source:pubmed"]',
      'exclude = ["source:semantic"]',
      "",
    ].join("\n");
    await writeFile(configPath, complete);
    const single = await loadConfig({ cwd: projectRoot });

    const fragments = path.join(appRoot, "config.d");
    await mkdir(fragments, { recursive: true });
    await writeFile(configPath, "schemaVersion = 1\n");
    await writeFile(path.join(fragments, "10-search.toml"), complete.split("\n").slice(1).join("\n"));
    const split = await loadConfig({ cwd: projectRoot });

    expect(split.search).toEqual(single.search);
    expect(split.workspace.root).toBe(single.workspace.root);
    expect(split.workspace.root).toBe(path.join(appRoot, "workspace"));
  });

  it("uses higher config layers as whole-definition replacements and preserves legacy selection", async () => {
    const { configPath, projectRoot } = await createRoot(
      "paper-search-config-fragment-layers-",
    );
    await writeFile(configPath, [
      "schemaVersion = 1",
      "[search.classifications.preferred]",
      'sources = ["crossref", "openalex"]',
      "[search.presets.custom]",
      'extends = ["general"]',
      'include = ["tag:preferred"]',
      'exclude = ["source:semantic"]',
      "",
    ].join("\n"));
    await writeFile(path.join(projectRoot, "paper-search.toml"), [
      "[search.selection]",
      'mode = "allowlist"',
      'includeIds = ["crossref"]',
      "[search.classifications.preferred]",
      'sources = ["pubmed"]',
      "[search.presets.custom]",
      'include = ["source:pubmed"]',
      "",
    ].join("\n"));

    const config = await loadConfig({ cwd: projectRoot });
    expect(config.search.classifications.preferred).toEqual({ sources: ["pubmed"] });
    expect(config.search.presets.custom).toEqual({
      extends: [],
      include: ["source:pubmed"],
      exclude: [],
    });
    expect(config.search.selection).toMatchObject({
      mode: "allowlist",
      includeIds: ["crossref"],
      excludeIds: [],
    });
    expect(config.search.defaultAcademicPresets).toEqual(["general"]);
  });

  it("ignores orphan fragment directories and rejects an explicit directory without its main file", async () => {
    const { appRoot, projectRoot, root } = await createRoot(
      "paper-search-config-fragment-orphan-",
    );
    const orphanUserFragments = path.join(appRoot, "config.d");
    const explicitRoot = path.join(root, "explicit");
    await mkdir(orphanUserFragments, { recursive: true });
    await mkdir(path.join(explicitRoot, "config.d"), { recursive: true });
    await writeFile(path.join(orphanUserFragments, "10-orphan.toml"), "[output]\nlocale = \"orphan\"\n");
    await writeFile(path.join(explicitRoot, "config.d", "10-orphan.toml"), "[output]\nlocale = \"orphan\"\n");

    await expect(loadConfig({ cwd: projectRoot })).resolves.toMatchObject({
      output: { locale: "zh-CN" },
      meta: { loadedFiles: [] },
    });
    await expect(loadConfig({ cwd: projectRoot, explicitConfigPath: explicitRoot })).rejects.toThrow(
      /Config file not found/,
    );
  });

  it("validates cross-file references after assembling the complete layer stack", async () => {
    const { appRoot, configPath, projectRoot } = await createRoot(
      "paper-search-config-fragment-validation-",
    );
    const fragments = path.join(appRoot, "config.d");
    await mkdir(fragments, { recursive: true });
    await writeFile(configPath, "schemaVersion = 1\n[search]\ndefaultAcademicPresets = [\"custom\"]\n");
    await writeFile(
      path.join(fragments, "10-preset.toml"),
      "[search.presets.custom]\nextends = [\"missing\"]\n",
    );

    await expect(validateConfigFiles({ cwd: projectRoot })).rejects.toThrow(
      /unknown search preset: missing/,
    );
  });
});
