import { CRSQLiteDB } from './crsqlite';
import type { CRChange } from './crsqlite';
import { WebRTCManager } from './webrtc';
import type { QueryResult, RTCBatteryConfig } from './types';

export type { QueryResult, RTCBatteryConfig, CRChange };

type EventType = 'sync' | 'peer-join' | 'peer-leave' | 'peer-ready' | 'error' | 'connected' | 'disconnected' | 'reconnecting' | 'reconnected';
type EventCallback = (...args: unknown[]) => void;

/**
 * RTCBattery - WebRTC + SQL + CRDT Replication (powered by cr-sqlite)
 */
export class RTCBattery {
  private config: RTCBatteryConfig;
  private db: CRSQLiteDB;
  private webrtc: WebRTCManager | null = null;
  private initialized = false;
  private connected = false;
  private eventListeners: Map<EventType, Set<EventCallback>> = new Map();
  private lastBroadcastVersion = 0;

  constructor(config: RTCBatteryConfig = {}) {
    this.config = {
      dbName: 'rtc-battery-default',
      ...config
    };
    this.db = new CRSQLiteDB();
  }

  /**
   * Initialize the database
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.db.open(this.config.dbName);
    this.initialized = true;

    // Watch for local changes to broadcast
    this.db.onUpdate((table, rowid) => {
      console.log('[RTCBattery] onUpdate fired:', table, rowid);
      this.broadcastLocalChanges();
    });
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

    this.webrtc = new WebRTCManager(this.db.getSiteId(), this.config.iceServers);

    // Handle sync requests from peers
    this.webrtc.onSyncRequest = async (_fromPeerId, sinceVersion) => {
      const changes = await this.db.getChanges(sinceVersion);
      return { changes, version: this.db.getVersion() };
    };

    // Handle incoming changes from peers
    this.webrtc.onChangesReceived = async (changes, fromPeerId) => {
      console.log('[RTCBattery] received', changes.length, 'changes from', fromPeerId);
      await this.db.applyChanges(changes);
      this.emit('sync', changes.length, fromPeerId);
    };

    // Provide local version for sync
    this.webrtc.getLocalVersion = () => {
      return this.db.getVersion();
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
    this.lastBroadcastVersion = this.db.getVersion();
    this.emit('connected');
  }

  /**
   * Broadcast local changes to peers
   */
  private async broadcastLocalChanges(): Promise<void> {
    console.log('[RTCBattery] broadcastLocalChanges called, connected:', this.connected, 'webrtc:', !!this.webrtc);
    if (!this.webrtc || !this.connected) return;

    const changes = await this.db.getChanges(this.lastBroadcastVersion);
    console.log('[RTCBattery] changes since version', this.lastBroadcastVersion, ':', changes.length);
    if (changes.length > 0) {
      const version = this.db.getVersion();
      console.log('[RTCBattery] broadcasting', changes.length, 'changes, new version:', version);
      this.webrtc.broadcastChanges(changes, version);
      this.lastBroadcastVersion = version;
    }
  }

  /**
   * Execute SQL query
   * All mutations are automatically tracked by cr-sqlite and synced to peers
   */
  async exec(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureInitialized();
    return await this.db.query(sql, params);
  }

  /**
   * Enable CRDT replication on a table
   * Call this after CREATE TABLE for any table you want to sync
   */
  async enableSync(tableName: string): Promise<void> {
    this.ensureInitialized();
    await this.db.enableCRR(tableName);
  }

  /**
   * Get local site ID (unique identifier for this node)
   */
  getNodeId(): string {
    this.ensureInitialized();
    return this.db.getSiteId();
  }

  /**
   * Get current database version
   */
  getVersion(): number {
    this.ensureInitialized();
    return this.db.getVersion();
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
    await this.db.close();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RTCBattery not initialized. Call init() first.');
    }
  }
}
