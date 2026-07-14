import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@iarna/toml";
import { describe, expect, it } from "vitest";
import { SubscriptionsConfigFileSchema } from "../../src/config/schema.js";
import { ExternalSearchConfigFileSchema } from "../../src/external-search/config.js";
import {
  classifyConfigKey,
  flattenUserConfig,
  parseCredentialsConfigDocument,
  parseUserConfigDocument,
} from "../../src/config/userConfig.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readToml(fileName: string): Promise<unknown> {
  return parse(await readFile(path.join(packageRoot, fileName), "utf8"));
}

describe("published split configuration examples", () => {
  it("keeps runtime settings in a strict v1 config without credential keys", async () => {
    const config = parseUserConfigDocument(await readToml("paper-search.example.toml"));
    expect(config.legacy).toBe(false);
    expect(
      flattenUserConfig(config.data).filter(
        (entry) => classifyConfigKey(entry.key) === "secret",
      ),
    ).toEqual([]);
  });

  it("validates search and material subscriptions independently", async () => {
    const subscriptions = SubscriptionsConfigFileSchema.parse(
      await readToml("subscriptions.example.toml"),
    );
    expect(Object.keys(subscriptions.subscriptions).sort()).toEqual([
      "official-material",
      "official-search",
    ]);
  });

  it("keeps only classified credential keys in the credential example", async () => {
    const credentials = parseCredentialsConfigDocument(
      await readToml("credentials.example.toml"),
    );
    expect(flattenUserConfig(credentials).length).toBeGreaterThan(0);
  });

  it("validates the dedicated external-search example independently", async () => {
    const external = ExternalSearchConfigFileSchema.parse(
      await readToml("external-search.example.toml"),
    );
    expect(external).toMatchObject({ schemaVersion: 1, enabled: true, adapter: "native" });
  });
});
