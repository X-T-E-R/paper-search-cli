import type { ResolvedConfig } from "../config/schema.js";

export interface ZoteroSelectionBinding {
  requested: boolean;
  origin: "global" | "workspace" | "workspace-off";
  collectionKeys: string[];
  attachmentMode: "none" | "link" | "import";
  markdownMode: "none" | "note" | "link" | "import";
}

export function resolveZoteroSelectionBinding(config: ResolvedConfig): ZoteroSelectionBinding {
  const binding = config.zoteroBinding;
  if (binding.mode === "off") {
    return {
      requested: false,
      origin: "workspace-off",
      collectionKeys: [],
      attachmentMode: "none",
      markdownMode: "none",
    };
  }
  if (binding.mode === "bound") {
    return {
      requested: true,
      origin: "workspace",
      collectionKeys: [...(binding.collectionKeys ?? [])],
      attachmentMode: binding.attachmentMode ?? config.zotero.attachmentMode,
      markdownMode: binding.markdownMode ?? config.zotero.markdownMode,
    };
  }
  return {
    requested: config.zotero.syncOnSelected,
    origin: "global",
    collectionKeys: [...config.zotero.collectionKeys],
    attachmentMode: config.zotero.attachmentMode,
    markdownMode: config.zotero.markdownMode,
  };
}
