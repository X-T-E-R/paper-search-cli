export type ZoteroUnavailablePolicy = "error" | "warn";

export interface ZoteroResolvedSettings {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  unavailable: ZoteroUnavailablePolicy;
}
export interface ZoteroWriteAction {
  action: "create_item" | "create_note";
  params: Record<string, unknown>;
}

export interface ZoteroSinkPlan {
  schemaVersion: 1;
  workspaceRoot: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
  actions: ZoteroWriteAction[];
  omissions: string[];
  planDigest: string;
}

export interface ZoteroSinkPreview {
  plan: ZoteroSinkPlan;
  endpoint: string;
  previewDigest: string;
  status: unknown;
  collectionProbe?: unknown;
  actionPreviews: unknown[];
}

export interface ZoteroSinkReceipt {
  schemaVersion: 1;
  receiptId: string;
  createdAt: string;
  status: "complete" | "partial";
  planDigest: string;
  previewDigest: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
  zoteroItemKey: string;
  zoteroNoteKey?: string;
  completedPhases: string[];
  failedPhase?: string;
  verification?: unknown;
}
