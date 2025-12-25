import type { HLC } from './hlc';

export type OperationType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface Operation {
  hlc: HLC;
  type: OperationType;
  table: string;
  pk: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  changes?: number;
  lastInsertRowId?: number;
}

export interface RTCBatteryConfig {
  signalingUrl?: string;
  token?: string;
  iceServers?: RTCIceServer[];
  dbName?: string;
}

export interface StoredOperation extends Operation {
  id: string; // HLC string for indexing
}
