export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface RTCBatteryConfig {
  signalingUrl?: string;
  token?: string;
  iceServers?: RTCIceServer[];
  dbName?: string;
}

// Re-export CRChange from crsqlite for sync
export type { CRChange } from './crsqlite';
