// src/crsqlite.ts
function uint8ToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
var sqliteInstance = null;
async function loadCrSqlite() {
  if (sqliteInstance) return sqliteInstance;
  const initWasm = (await import("@vlcn.io/crsqlite-wasm")).default;
  sqliteInstance = await initWasm();
  return sqliteInstance;
}
var CRSQLiteDB = class {
  db = null;
  siteId = "";
  dbVersion = 0;
  async open(dbName = ":memory:") {
    const sqlite = await loadCrSqlite();
    this.db = await sqlite.open(dbName);
    const result = await this.db.execA("SELECT crsql_site_id()");
    const siteIdBytes = result[0][0];
    this.siteId = Array.from(siteIdBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.refreshVersion();
  }
  getDb() {
    if (!this.db) throw new Error("Database not opened");
    return this.db;
  }
  async refreshVersion() {
    const result = await this.getDb().execA("SELECT crsql_db_version()");
    this.dbVersion = Number(result[0]?.[0] ?? 0);
  }
  /**
   * Execute SQL statement(s)
   */
  async exec(sql, params) {
    await this.getDb().exec(sql, params);
  }
  /**
   * Execute SQL and return results as objects
   */
  async execO(sql, params) {
    const result = await this.getDb().execO(sql, params);
    return result ?? [];
  }
  /**
   * Execute SQL and return results as arrays
   */
  async execA(sql, params) {
    const result = await this.getDb().execA(sql, params);
    return result ?? [];
  }
  /**
   * Execute SQL and return QueryResult format (for API compatibility)
   */
  async query(sql, params) {
    const objRows = await this.getDb().execO(sql, params);
    if (!objRows || objRows.length === 0) {
      return { columns: [], rows: [] };
    }
    const columns = Object.keys(objRows[0]);
    const rows = objRows.map((row) => columns.map((col) => row[col]));
    return { columns, rows };
  }
  /**
   * Enable CRDT tracking on a table
   */
  async enableCRR(tableName) {
    await this.getDb().exec(`SELECT crsql_as_crr('${tableName}')`);
  }
  /**
   * Get site ID as hex string
   */
  getSiteId() {
    if (!this.siteId) throw new Error("Database not opened");
    return this.siteId;
  }
  /**
   * Get current database version
   */
  getVersion() {
    return this.dbVersion;
  }
  /**
   * Get changes since a given version
   */
  async getChanges(sinceVersion = 0) {
    await this.refreshVersion();
    const rows = await this.getDb().execO(
      `SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq"
       FROM crsql_changes
       WHERE db_version > ?`,
      [sinceVersion]
    );
    return rows.map((row) => ({
      ...row,
      pk: uint8ToBase64(row.pk),
      site_id: uint8ToBase64(row.site_id)
    }));
  }
  /**
   * Apply changes from another peer
   */
  async applyChanges(changes) {
    const db = this.getDb();
    for (const change of changes) {
      const pk = base64ToUint8(change.pk);
      const siteId = base64ToUint8(change.site_id);
      await db.exec(
        `INSERT INTO crsql_changes ("table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          change.table,
          pk,
          change.cid,
          change.val,
          change.col_version,
          change.db_version,
          siteId,
          change.cl,
          change.seq
        ]
      );
    }
    await this.refreshVersion();
  }
  /**
   * Register for update notifications
   */
  onUpdate(callback) {
    return this.getDb().onUpdate((_type, _dbName, tblName, rowid) => {
      if (!tblName.startsWith("crsql_") && !tblName.startsWith("__crsql_")) {
        callback(tblName, rowid);
      }
    });
  }
  /**
   * Close the database
   */
  async close() {
    if (this.db) {
      await this.db.exec("SELECT crsql_finalize()");
      this.db.close();
      this.db = null;
    }
  }
};

// src/signaling.ts
var SignalingClient = class {
  ws = null;
  url;
  token;
  peerId;
  reconnectAttempts = 0;
  maxReconnectAttempts = 10;
  baseDelay = 1e3;
  maxDelay = 3e4;
  handlers = /* @__PURE__ */ new Map();
  shouldReconnect = true;
  isInitialConnect = true;
  constructor(url, token, peerId) {
    this.url = url;
    this.token = token;
    this.peerId = peerId;
  }
  async connect() {
    this.shouldReconnect = true;
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error("WebSocket connection failed"));
        return;
      }
      const onOpen = () => {
        cleanup();
        this.reconnectAttempts = 0;
        if (!this.isInitialConnect) {
          this.emit("reconnected", { type: "reconnected" });
        }
        this.isInitialConnect = false;
        this.send({ type: "join", peerId: this.peerId });
        resolve();
      };
      const onError = () => {
        cleanup();
        if (this.isInitialConnect) {
          reject(new Error("WebSocket connection failed"));
        }
      };
      const cleanup = () => {
        this.ws?.removeEventListener("open", onOpen);
        this.ws?.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
      this.ws.onclose = () => {
        this.handleDisconnect();
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.emit(msg.type, msg);
        } catch (e) {
          console.error("Failed to parse signaling message:", e);
        }
      };
    });
  }
  handleDisconnect() {
    if (!this.shouldReconnect) {
      this.emit("disconnected", { type: "disconnected" });
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(
        this.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
        this.maxDelay
      );
      this.emit("reconnecting", {
        type: "reconnecting",
        attempt: this.reconnectAttempts
      });
      setTimeout(() => {
        if (this.shouldReconnect) {
          this.connect().catch(() => {
          });
        }
      }, delay);
    } else {
      this.emit("disconnected", { type: "disconnected" });
    }
  }
  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
  sendOffer(to, sdp) {
    this.send({ type: "offer", to, sdp });
  }
  sendAnswer(to, sdp) {
    this.send({ type: "answer", to, sdp });
  }
  sendIceCandidate(to, candidate) {
    this.send({ type: "ice", to, candidate });
  }
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, /* @__PURE__ */ new Set());
    }
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
  emit(event, data) {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (e) {
        console.error("Signaling handler error:", e);
      }
    });
  }
  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }
  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
};

// src/webrtc.ts
var DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
var WebRTCManager = class {
  signaling = null;
  peers = /* @__PURE__ */ new Map();
  iceServers;
  localPeerId;
  // Callbacks
  onSyncRequest = null;
  onChangesReceived = null;
  onPeerJoin = null;
  onPeerLeave = null;
  onPeerReady = null;
  onReconnecting = null;
  onReconnected = null;
  onDisconnected = null;
  getLocalVersion = null;
  constructor(localPeerId, iceServers) {
    this.localPeerId = localPeerId;
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;
  }
  async connect(signalingUrl, token) {
    this.signaling = new SignalingClient(signalingUrl, token, this.localPeerId);
    this.signaling.on("peers", (event) => {
      if (event.type === "peers") {
        for (const peerId of event.peerIds) {
          if (peerId !== this.localPeerId) {
            this.createPeerConnection(peerId, true);
          }
        }
      }
    });
    this.signaling.on("peer-join", (event) => {
      if (event.type === "peer-join" && event.peerId !== this.localPeerId) {
        this.onPeerJoin?.(event.peerId);
      }
    });
    this.signaling.on("peer-leave", (event) => {
      if (event.type === "peer-leave") {
        this.removePeer(event.peerId);
        this.onPeerLeave?.(event.peerId);
      }
    });
    this.signaling.on("offer", async (event) => {
      if (event.type === "offer") {
        await this.handleOffer(event.from, event.sdp);
      }
    });
    this.signaling.on("answer", async (event) => {
      if (event.type === "answer") {
        await this.handleAnswer(event.from, event.sdp);
      }
    });
    this.signaling.on("ice", async (event) => {
      if (event.type === "ice") {
        await this.handleIceCandidate(event.from, event.candidate);
      }
    });
    this.signaling.on("reconnecting", (event) => {
      if (event.type === "reconnecting") {
        this.onReconnecting?.(event.attempt);
      }
    });
    this.signaling.on("reconnected", () => {
      this.onReconnected?.();
    });
    this.signaling.on("disconnected", () => {
      this.onDisconnected?.();
    });
    await this.signaling.connect();
  }
  async createPeerConnection(peerId, initiator) {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peerConn = { pc, dc: null, ready: false, lastSyncedVersion: 0 };
    this.peers.set(peerId, peerConn);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling?.sendIceCandidate(peerId, event.candidate.toJSON());
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removePeer(peerId);
        this.onPeerLeave?.(peerId);
      }
    };
    if (initiator) {
      const dc = pc.createDataChannel("rtc-battery", { ordered: true });
      this.setupDataChannel(dc, peerId, peerConn);
      peerConn.dc = dc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling?.sendOffer(peerId, offer);
    } else {
      pc.ondatachannel = (event) => {
        peerConn.dc = event.channel;
        this.setupDataChannel(event.channel, peerId, peerConn);
      };
    }
  }
  setupDataChannel(dc, peerId, peerConn) {
    dc.onopen = () => {
      peerConn.ready = true;
      this.onPeerReady?.(peerId);
      const localVersion = this.getLocalVersion?.() ?? 0;
      this.sendToPeer(peerId, { type: "sync-request", version: localVersion });
    };
    dc.onclose = () => {
      peerConn.ready = false;
    };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleChannelMessage(msg, peerId, peerConn);
      } catch (e) {
        console.error("Failed to parse channel message:", e);
      }
    };
  }
  async handleChannelMessage(msg, fromPeerId, peerConn) {
    switch (msg.type) {
      case "sync-request": {
        const result = await this.onSyncRequest?.(fromPeerId, msg.version);
        if (result) {
          this.sendToPeer(fromPeerId, {
            type: "sync-response",
            changes: result.changes,
            version: result.version
          });
        }
        break;
      }
      case "sync-response": {
        if (msg.changes.length > 0) {
          await this.onChangesReceived?.(msg.changes, fromPeerId);
        }
        peerConn.lastSyncedVersion = msg.version;
        break;
      }
      case "changes": {
        if (msg.changes.length > 0) {
          await this.onChangesReceived?.(msg.changes, fromPeerId);
        }
        peerConn.lastSyncedVersion = msg.version;
        break;
      }
      case "ping":
        this.sendToPeer(fromPeerId, { type: "pong" });
        break;
      case "pong":
        break;
    }
  }
  async handleOffer(from, sdp) {
    await this.createPeerConnection(from, false);
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.signaling?.sendAnswer(from, answer);
  }
  async handleAnswer(from, sdp) {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(sdp);
  }
  async handleIceCandidate(from, candidate) {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.addIceCandidate(candidate);
  }
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dc?.close();
      peer.pc.close();
      this.peers.delete(peerId);
    }
  }
  sendToPeer(peerId, message) {
    const peer = this.peers.get(peerId);
    if (peer?.dc?.readyState === "open") {
      peer.dc.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
  /**
   * Broadcast changes to all connected peers
   */
  broadcastChanges(changes, version) {
    const message = { type: "changes", changes, version };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === "open") {
        peer.dc.send(JSON.stringify(message));
        peer.lastSyncedVersion = version;
      }
    }
  }
  getConnectedPeers() {
    return Array.from(this.peers.entries()).filter(([_, peer]) => peer.ready).map(([id]) => id);
  }
  disconnect() {
    for (const [peerId] of this.peers) {
      this.removePeer(peerId);
    }
    this.signaling?.disconnect();
    this.signaling = null;
  }
  isConnected() {
    return this.signaling?.isConnected() ?? false;
  }
};

// src/index.ts
var RTCBattery = class {
  config;
  db;
  webrtc = null;
  initialized = false;
  connected = false;
  eventListeners = /* @__PURE__ */ new Map();
  lastBroadcastVersion = 0;
  constructor(config = {}) {
    this.config = {
      dbName: "rtc-battery-default",
      ...config
    };
    this.db = new CRSQLiteDB();
  }
  /**
   * Initialize the database
   */
  async init() {
    if (this.initialized) return;
    await this.db.open(this.config.dbName);
    this.initialized = true;
    this.db.onUpdate((table, rowid) => {
      console.log("[RTCBattery] onUpdate fired:", table, rowid);
      this.broadcastLocalChanges();
    });
  }
  /**
   * Connect to signaling server and start P2P sync
   */
  async connect(signalingUrl, token) {
    this.ensureInitialized();
    const url = signalingUrl || this.config.signalingUrl;
    const roomToken = token || this.config.token;
    if (!url) {
      throw new Error("Signaling URL required. Provide in config or connect() call.");
    }
    if (!roomToken) {
      throw new Error("Token required. Provide in config or connect() call.");
    }
    this.webrtc = new WebRTCManager(this.db.getSiteId(), this.config.iceServers);
    this.webrtc.onSyncRequest = async (_fromPeerId, sinceVersion) => {
      const changes = await this.db.getChanges(sinceVersion);
      return { changes, version: this.db.getVersion() };
    };
    this.webrtc.onChangesReceived = async (changes, fromPeerId) => {
      console.log("[RTCBattery] received", changes.length, "changes from", fromPeerId);
      await this.db.applyChanges(changes);
      this.emit("sync", changes.length, fromPeerId);
    };
    this.webrtc.getLocalVersion = () => {
      return this.db.getVersion();
    };
    this.webrtc.onPeerJoin = (peerId) => {
      this.emit("peer-join", peerId);
    };
    this.webrtc.onPeerLeave = (peerId) => {
      this.emit("peer-leave", peerId);
    };
    this.webrtc.onPeerReady = (peerId) => {
      this.emit("peer-ready", peerId);
    };
    this.webrtc.onReconnecting = (attempt) => {
      this.emit("reconnecting", attempt);
    };
    this.webrtc.onReconnected = () => {
      this.emit("reconnected");
    };
    this.webrtc.onDisconnected = () => {
      this.connected = false;
      this.emit("disconnected");
    };
    await this.webrtc.connect(url, roomToken);
    this.connected = true;
    this.lastBroadcastVersion = this.db.getVersion();
    this.emit("connected");
  }
  /**
   * Broadcast local changes to peers
   */
  async broadcastLocalChanges() {
    console.log("[RTCBattery] broadcastLocalChanges called, connected:", this.connected, "webrtc:", !!this.webrtc);
    if (!this.webrtc || !this.connected) return;
    const changes = await this.db.getChanges(this.lastBroadcastVersion);
    console.log("[RTCBattery] changes since version", this.lastBroadcastVersion, ":", changes.length);
    if (changes.length > 0) {
      const version = this.db.getVersion();
      console.log("[RTCBattery] broadcasting", changes.length, "changes, new version:", version);
      this.webrtc.broadcastChanges(changes, version);
      this.lastBroadcastVersion = version;
    }
  }
  /**
   * Execute SQL query
   * All mutations are automatically tracked by cr-sqlite and synced to peers
   */
  async exec(sql, params) {
    this.ensureInitialized();
    return await this.db.query(sql, params);
  }
  /**
   * Enable CRDT replication on a table
   * Call this after CREATE TABLE for any table you want to sync
   */
  async enableSync(tableName) {
    this.ensureInitialized();
    await this.db.enableCRR(tableName);
  }
  /**
   * Get local site ID (unique identifier for this node)
   */
  getNodeId() {
    this.ensureInitialized();
    return this.db.getSiteId();
  }
  /**
   * Get current database version
   */
  getVersion() {
    this.ensureInitialized();
    return this.db.getVersion();
  }
  /**
   * Get connected peer IDs
   */
  getPeers() {
    return this.webrtc?.getConnectedPeers() || [];
  }
  /**
   * Check if connected to signaling server
   */
  isConnected() {
    return this.connected && (this.webrtc?.isConnected() ?? false);
  }
  /**
   * Event subscription
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, /* @__PURE__ */ new Set());
    }
    this.eventListeners.get(event).add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }
  emit(event, ...args) {
    this.eventListeners.get(event)?.forEach((cb) => {
      try {
        cb(...args);
      } catch (e) {
        console.error("Event listener error:", e);
      }
    });
  }
  /**
   * Disconnect from peers and signaling
   */
  disconnect() {
    this.webrtc?.disconnect();
    this.webrtc = null;
    this.connected = false;
    this.emit("disconnected");
  }
  /**
   * Close and cleanup everything
   */
  async close() {
    this.disconnect();
    await this.db.close();
    this.initialized = false;
  }
  ensureInitialized() {
    if (!this.initialized) {
      throw new Error("RTCBattery not initialized. Call init() first.");
    }
  }
};
export {
  RTCBattery
};
