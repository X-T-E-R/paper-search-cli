import type { ResolvedConfig } from "../config/schema.js";
import { syncSelectedItemToZotero, type ZoteroAutoSyncResult } from "../zotero/autoSync.js";
import {
  addResourceToWorkspace,
  type WorkspaceAddOptions,
  type WorkspaceCollectionRecord,
  type WorkspaceItemRecord,
} from "./store.js";

export interface WorkspaceSelectionWithIntegrations {
  workspace: {
    record: WorkspaceItemRecord;
    collection: WorkspaceCollectionRecord;
  };
  zoteroSync: ZoteroAutoSyncResult;
}

export async function selectResourceIntoWorkspace(
  config: ResolvedConfig,
  options: WorkspaceAddOptions,
): Promise<WorkspaceSelectionWithIntegrations> {
  const workspace = await addResourceToWorkspace(config.workspace.root, options);
  const zoteroSync = await syncSelectedItemToZotero({
    config,
    itemId: workspace.record.id,
  });
  return { workspace, zoteroSync };
}
