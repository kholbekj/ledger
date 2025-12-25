import { HybridClock, HLC } from './hlc';
import { SQLLayer } from './sql';
import { Storage } from './storage';
import { WebRTCManager } from './webrtc';
import type { Operation, QueryResult, RTCBatteryConfig } from './types';

export type { Operation, QueryResult, RTCBatteryConfig, HLC };
export { HybridClock };

type EventType = 'sync' | 'peer-join' | 'peer-leave' | 'peer-ready' | 'error' | 'operation' | 'connected' | 'disconnected' | 'reconnecting' | 'reconnected';
type EventCallback = (...args: unknown[]) => void;

/**
 * RTCBattery - WebRTC + SQL + CRDT Replication
 */
export class RTCBattery {
  private config: RTCBatteryConfig;
  private sql: SQLLayer;
  private storage: Storage;
  private clock: HybridClock;
  private webrtc: WebRTCManager | null = null;
  private initialized = false;
  private connected = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private eventListeners: Map<EventType, Set<EventCallback>> = new Map();

  // Cache for sync responses (sync callback can't be async)
  private operationsCache: Operation[] = [];
  private operationsCacheVersion: string | undefined;

  constructor(config: RTCBatteryConfig = {}) {
    this.config = {
      dbName: 'rtc-battery-default',
      ...config
    };
    this.sql = new SQLLayer();
    this.storage = new Storage(this.config.dbName!);
    this.clock = new HybridClock();
  }

  /**
   * Initialize the database (local only)
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.storage.open();

    const existingData = await this.storage.loadDatabase();
    await this.sql.init(existingData || undefined);

    this.initialized = true;

    // Load operations cache for sync
    await this.updateOperationsCache();

    this.scheduleSave();
  }

  /**
   * Connect to signaling server and start P2P sync
   */
  async connect(signalingUrl?: string, token?: string): Promise<void> {
    this.ensureInitialized();

    const url = signalingUrl || this.config.signalingUrl;
    const roomToken = token || this.config.token;

    if (!url) {
      throw new Error('Signaling URL required. Provide in config or connect() call.');
    }
    if (!roomToken) {
      throw new Error('Token required. Provide in config or connect() call.');
    }

    this.webrtc = new WebRTCManager(this.clock.getNodeId(), this.config.iceServers);

    // Operation handler
    this.webrtc.onOperation = async (op, fromPeerId) => {
      await this.applyRemoteOperation(op);
      this.emit('operation', op, fromPeerId);
    };

    // Sync request handler - returns operations newer than fromVersion
    this.webrtc.onSyncRequest = (fromPeerId, fromVersion) => {
      return this.getCachedOperations(fromVersion);
    };

    // Provide local version for sync protocol
    this.webrtc.getLocalVersion = () => {
      return this.operationsCacheVersion;
    };

    // Peer events
    this.webrtc.onPeerJoin = (peerId) => {
      this.emit('peer-join', peerId);
    };

    this.webrtc.onPeerLeave = (peerId) => {
      this.emit('peer-leave', peerId);
    };

    this.webrtc.onPeerReady = (peerId) => {
      this.emit('peer-ready', peerId);
    };

    // Reconnection events
    this.webrtc.onReconnecting = (attempt) => {
      this.emit('reconnecting', attempt);
    };

    this.webrtc.onReconnected = () => {
      this.emit('reconnected');
    };

    this.webrtc.onDisconnected = () => {
      this.connected = false;
      this.emit('disconnected');
    };

    await this.webrtc.connect(url, roomToken);
    this.connected = true;
    this.emit('connected');
  }

  private getCachedOperations(fromVersion?: string): Operation[] {
    if (!fromVersion) {
      return this.operationsCache;
    }

    // Return only operations newer than fromVersion (delta sync)
    const index = this.operationsCache.findIndex(op => {
      return HybridClock.toString(op.hlc) === fromVersion;
    });

    if (index === -1) {
      // Version not found, send all
      return this.operationsCache;
    }

    // Return operations after the found version
    return this.operationsCache.slice(index + 1);
  }

  private async updateOperationsCache(): Promise<void> {
    this.operationsCache = await this.storage.getOperations();
    if (this.operationsCache.length > 0) {
      const lastOp = this.operationsCache[this.operationsCache.length - 1];
      this.operationsCacheVersion = HybridClock.toString(lastOp.hlc);
    } else {
      this.operationsCacheVersion = undefined;
    }
  }

  /**
   * Execute SQL query
   * Mutations are automatically tracked as operations and synced to peers
   */
  async exec(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureInitialized();

    const isMutation = this.isMutation(sql);
    const hlc = isMutation ? this.clock.now() : undefined;

    const { result, operations } = this.sql.execute(sql, params, hlc);

    for (const op of operations) {
      await this.storage.saveOperation(op);
      this.emit('operation', op);

      if (this.webrtc) {
        this.webrtc.broadcast(op);
      }
    }

    if (operations.length > 0) {
      await this.updateOperationsCache();
      this.scheduleSave();
    }

    return result;
  }

  /**
   * Execute SQL without CRDT tracking (local only, not synced)
   */
  async execLocal(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureInitialized();
    const { result } = this.sql.execute(sql, params);
    return result;
  }

  /**
   * Apply a remote operation (from another peer)
   */
  async applyRemoteOperation(op: Operation): Promise<void> {
    this.ensureInitialized();

    this.clock.receive(op.hlc);
    this.sql.applyOperation(op);
    await this.storage.saveOperation(op);
    await this.updateOperationsCache();
    this.scheduleSave();
  }

  /**
   * Get all operations after a given HLC (for sync)
   */
  async getOperationsAfter(afterHlc?: string): Promise<Operation[]> {
    return this.storage.getOperations(afterHlc);
  }

  /**
   * Get current operation count
   */
  async getOperationCount(): Promise<number> {
    return this.storage.getOperationCount();
  }

  /**
   * Get current version (HLC string of last operation)
   */
  getVersion(): string | undefined {
    return this.operationsCacheVersion;
  }

  /**
   * Export database as binary
   */
  exportDatabase(): Uint8Array {
    this.ensureInitialized();
    return this.sql.export();
  }

  /**
   * Import database from binary
   */
  importDatabase(data: Uint8Array): void {
    this.ensureInitialized();
    this.sql.import(data);
    this.scheduleSave();
  }

  /**
   * Get local node ID
   */
  getNodeId(): string {
    return this.clock.getNodeId();
  }

  /**
   * Get connected peer IDs
   */
  getPeers(): string[] {
    return this.webrtc?.getConnectedPeers() || [];
  }

  /**
   * Check if connected to signaling server
   */
  isConnected(): boolean {
    return this.connected && (this.webrtc?.isConnected() ?? false);
  }

  /**
   * Event subscription
   */
  on(event: EventType, callback: EventCallback): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);

    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  private emit(event: EventType, ...args: unknown[]): void {
    this.eventListeners.get(event)?.forEach(cb => {
      try {
        cb(...args);
      } catch (e) {
        console.error('Event listener error:', e);
      }
    });
  }

  /**
   * Disconnect from peers and signaling
   */
  disconnect(): void {
    this.webrtc?.disconnect();
    this.webrtc = null;
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Close and cleanup everything
   */
  async close(): Promise<void> {
    this.disconnect();

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      await this.saveDatabase();
    }
    this.sql.close();
    this.storage.close();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RTCBattery not initialized. Call init() first.');
    }
  }

  private isMutation(sql: string): boolean {
    const normalized = sql.trim().toUpperCase();
    return (
      normalized.startsWith('INSERT') ||
      normalized.startsWith('UPDATE') ||
      normalized.startsWith('DELETE')
    );
  }

  private scheduleSave(): void {
    if (this.saveTimeout) return;

    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.saveDatabase();
    }, 1000);
  }

  private async saveDatabase(): Promise<void> {
    try {
      const data = this.sql.export();
      await this.storage.saveDatabase(data);
    } catch (e) {
      console.error('Failed to save database:', e);
      this.emit('error', e);
    }
  }
}
