/** A durable reference to bytes written below an explicitly resolved local root. */
export interface LocalStorageRefV1 {
  schemaVersion: 1;
  sink: "local";
  area: "artifact" | "extraction" | "export";
  /** Normalized absolute root captured when the bytes were committed. */
  root: string;
  /** Portable forward-slash relative key. */
  key: string;
  sha256?: string;
  sizeBytes?: number;
}

export type LocalStorageArea = LocalStorageRefV1["area"];
