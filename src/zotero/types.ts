export type ZoteroUnavailablePolicy = "error" | "warn";

export interface ZoteroResolvedSettings {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  unavailable: ZoteroUnavailablePolicy;
}
export interface ZoteroWriteAction {
  action:
    | "create_item"
    | "update_item"
    | "create_note"
    | "update_note"
    | "add_to_collection"
    | "attach_file";
  params: Record<string, unknown>;
  sourceRef?: string;
}

export interface ZoteroItemMapping {
  schemaVersion: 1;
  itemId: string;
  zoteroItemKey: string;
  noteKeys: Record<string, string>;
  attachments: Record<string, {
    zoteroAttachmentKey: string;
    mode: "link" | "import";
    filePath: string;
    /** False means Zotero returned the created key but post-write verification failed. */
    verified?: boolean;
  }>;
  updatedAt: string;
}

/** Exact host-owned identity for deduplicating one institutional projection. */
export interface ZoteroProjectionCorrelation {
  kind: "institutional-artifact";
  institutionalJobId: string;
  artifactId: string;
  storageSha256: string;
}

export interface ZoteroSinkPlan {
  schemaVersion: 1;
  workspaceRoot: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
  collectionKeys: string[];
  existingZoteroItemKey?: string;
  actions: ZoteroWriteAction[];
  omissions: string[];
  projectionCorrelation?: ZoteroProjectionCorrelation;
  planDigest: string;
}

export interface ZoteroSinkPreview {
  plan: ZoteroSinkPlan;
  endpoint: string;
  previewDigest: string;
  status: unknown;
  collectionProbe?: unknown;
  collectionProbes?: Record<string, unknown>;
  actionPreviews: unknown[];
}

export interface ZoteroSinkReceipt {
  schemaVersion: 1;
  receiptId: string;
  createdAt: string;
  status: "complete" | "partial" | "pending";
  planDigest: string;
  previewDigest: string;
  itemId: string;
  extractionId?: string;
  collectionKey?: string;
  collectionKeys?: string[];
  zoteroItemKey?: string;
  zoteroNoteKey?: string;
  zoteroAttachmentKeys?: string[];
  completedPhases: string[];
  failedPhase?: string;
  pendingReason?: string;
  verification?: unknown;
  /** Present only when remote writes succeeded but the canonical mapping could not be persisted. */
  mappingRecovery?: ZoteroItemMapping;
  projectionCorrelation?: ZoteroProjectionCorrelation;
}
