import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { expandRegistryUrlCandidates } from "./urlCandidates.js";
import { sanitizeUrlForDisplay } from "../../runtime/sanitizeUrl.js";

const RegistryEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  downloadUrl: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  minPluginVersion: z.string().regex(/^\d+\.\d+\.\d+/).optional(),
});

const RegistryInventoryEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
    kind: z.literal("search"),
    sourceType: z.enum(["academic", "patent"]),
    entryKind: z.enum(["source", "view"]),
    sourceId: z.string().min(1).optional(),
    backingSourceIds: z.array(z.string().min(1)).optional(),
    aliases: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).optional(),
    serviceFamily: z.string().min(1),
    transport: z.enum(["api", "html"]),
    domains: z.array(z.enum([
      "biomedicine",
      "computer-science",
      "cryptography",
      "engineering",
      "life-sciences",
      "multidisciplinary",
      "patents",
    ])).min(1),
    contentKinds: z.array(z.enum([
      "book",
      "conference-paper",
      "journal-article",
      "patent",
      "preprint",
      "repository-record",
    ])).min(1),
    access: z.array(z.enum([
      "credentialed",
      "institutional",
      "public",
      "session-gated",
    ])).min(1),
    selection: z.object({ defaultInAll: z.boolean() }).strict(),
    publication: z.object({
      status: z.enum(["published", "retained-unpublished"]),
      blockers: z.array(z.string().min(1)).optional(),
    }),
    provenance: z
      .object({
        reference: z.string().min(1),
        revision: z.string().min(1),
        paths: z.array(z.string().min(1)),
      })
      .optional(),
  })
  .superRefine((entry, context) => {
    if (entry.entryKind === "source" && !entry.sourceId) {
      context.addIssue({ code: "custom", message: "source inventory entry requires sourceId" });
    }
    if (entry.entryKind === "source" && entry.backingSourceIds !== undefined) {
      context.addIssue({ code: "custom", message: "source inventory entry cannot have backingSourceIds" });
    }
    if (entry.entryKind === "view" && entry.sourceId !== undefined) {
      context.addIssue({ code: "custom", message: "view inventory entry cannot have sourceId" });
    }
    if (entry.entryKind === "view" && !entry.backingSourceIds?.length) {
      context.addIssue({ code: "custom", message: "view inventory entry requires backingSourceIds" });
    }
    if (entry.entryKind === "view" && entry.selection.defaultInAll) {
      context.addIssue({ code: "custom", message: "view inventory cannot default into platform=all" });
    }
  });

const RegistryManifestSchema = z.object({
  providers: z.array(RegistryEntrySchema),
  inventory: z.array(RegistryInventoryEntrySchema).default([]),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
export type RegistryInventoryEntry = z.infer<typeof RegistryInventoryEntrySchema>;
export type RegistryManifest = z.infer<typeof RegistryManifestSchema>;

export interface LoadedRegistryManifest {
  source: string;
  resolvedFrom: string;
  kind: "local" | "remote";
  base: string;
  manifest: RegistryManifest;
}

export interface LoadedRegistryArchive {
  resolvedRef: string;
  bytes: Uint8Array;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function parseRegistryManifest(raw: string): RegistryManifest {
  const manifest = RegistryManifestSchema.parse(JSON.parse(raw));
  const seen = new Set<string>();
  for (const entry of manifest.providers) {
    if (seen.has(entry.id)) throw new Error(`duplicate provider id: ${entry.id}`);
    seen.add(entry.id);
  }
  const inventoryIds = new Set<string>();
  const sourceIds = new Set(
    manifest.inventory.flatMap((entry) =>
      entry.entryKind === "source" && entry.sourceId ? [entry.sourceId] : [],
    ),
  );
  for (const entry of manifest.inventory) {
    if (inventoryIds.has(entry.id)) throw new Error(`duplicate inventory id: ${entry.id}`);
    inventoryIds.add(entry.id);
    for (const sourceId of entry.backingSourceIds ?? []) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`inventory view ${entry.id} references unknown source: ${sourceId}`);
      }
    }
  }
  return manifest;
}

export async function loadRegistryManifest(source: string): Promise<LoadedRegistryManifest> {
  if (isHttpUrl(source)) {
    const candidates = expandRegistryUrlCandidates(source);
    const errors: string[] = [];
    for (const candidate of candidates) {
      let response: Response;
      try {
        response = await fetch(candidate, { cache: "no-store" });
      } catch {
        errors.push(`${sanitizeUrlForDisplay(candidate)} -> request failed`);
        continue;
      }
      if (!response.ok) {
        errors.push(`${sanitizeUrlForDisplay(candidate)} -> HTTP ${response.status}`);
        continue;
      }
      try {
        const manifest = parseRegistryManifest(await response.text());
        return {
          source: sanitizeUrlForDisplay(source),
          resolvedFrom: sanitizeUrlForDisplay(candidate),
          kind: "remote",
          base: candidate,
          manifest,
        };
      } catch (error) {
        errors.push(
          `${sanitizeUrlForDisplay(candidate)} -> ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(errors.length ? errors.join(" | ") : "Unable to load remote registry");
  }

  const resolved = path.resolve(source);
  const raw = await readFile(resolved, "utf8");
  return {
    source,
    resolvedFrom: resolved,
    kind: "local",
    base: resolved,
    manifest: parseRegistryManifest(raw),
  };
}

export function resolveRegistryDownloadUrl(
  registry: LoadedRegistryManifest,
  downloadUrl: string,
): string {
  if (isHttpUrl(downloadUrl) || path.isAbsolute(downloadUrl)) {
    return downloadUrl;
  }
  if (registry.kind === "remote") {
    return new URL(downloadUrl, registry.base).toString();
  }
  return path.resolve(path.dirname(registry.base), downloadUrl);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadRegistryArchive(
  registry: LoadedRegistryManifest,
  entry: RegistryEntry,
): Promise<LoadedRegistryArchive> {
  const resolvedRef = resolveRegistryDownloadUrl(registry, entry.downloadUrl);
  let bytes: Uint8Array;
  if (isHttpUrl(resolvedRef)) {
    let response: Response;
    try {
      response = await fetch(resolvedRef, { cache: "no-store" });
    } catch (error) {
      throw new Error(`Download failed for ${entry.id}: network request failed`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = new Uint8Array(await readFile(resolvedRef));
  }
  if (entry.sha256) {
    const actual = sha256Hex(bytes);
    if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`SHA-256 checksum mismatch for ${entry.id}`);
    }
  }
  return { resolvedRef: sanitizeUrlForDisplay(resolvedRef), bytes };
}
