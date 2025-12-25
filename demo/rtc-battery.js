// src/hlc.ts
var HybridClock = class {
  ts = 0;
  counter = 0;
  nodeId;
  constructor(nodeId) {
    this.nodeId = nodeId || crypto.randomUUID();
  }
  getNodeId() {
    return this.nodeId;
  }
  /**
   * Generate a new timestamp for a local event
   */
  now() {
    const physicalNow = Date.now();
    if (physicalNow > this.ts) {
      this.ts = physicalNow;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return {
      ts: this.ts,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }
  /**
   * Update local clock based on received remote timestamp
   * Returns a new timestamp that is guaranteed to be greater than both local and remote
   */
  receive(remote) {
    const physicalNow = Date.now();
    const maxTs = Math.max(this.ts, remote.ts, physicalNow);
    if (maxTs === this.ts && maxTs === remote.ts) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxTs === this.ts) {
      this.counter++;
    } else if (maxTs === remote.ts) {
      this.ts = remote.ts;
      this.counter = remote.counter + 1;
    } else {
      this.ts = physicalNow;
      this.counter = 0;
    }
    this.ts = maxTs;
    return {
      ts: this.ts,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }
  /**
   * Compare two HLCs
   * Returns: -1 if a < b, 0 if a == b, 1 if a > b
   */
  static compare(a, b) {
    if (a.ts !== b.ts) {
      return a.ts < b.ts ? -1 : 1;
    }
    if (a.counter !== b.counter) {
      return a.counter < b.counter ? -1 : 1;
    }
    if (a.nodeId !== b.nodeId) {
      return a.nodeId < b.nodeId ? -1 : 1;
    }
    return 0;
  }
  /**
   * Convert HLC to a sortable string representation
   */
  static toString(hlc) {
    const ts = hlc.ts.toString(36).padStart(11, "0");
    const counter = hlc.counter.toString(36).padStart(5, "0");
    return `${ts}-${counter}-${hlc.nodeId}`;
  }
  /**
   * Parse HLC from string representation
   */
  static fromString(str) {
    const parts = str.split("-");
    if (parts.length < 3) {
      throw new Error("Invalid HLC string");
    }
    return {
      ts: parseInt(parts[0], 36),
      counter: parseInt(parts[1], 36),
      nodeId: parts.slice(2).join("-")
    };
  }
};

// src/sql.ts
var SQL = null;
async function loadSqlJs() {
  if (SQL) return SQL;
  if (typeof initSqlJs !== "undefined") {
    SQL = await initSqlJs({
      locateFile: (file) => `https://sql.js.org/dist/${file}`
    });
    return SQL;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://sql.js.org/dist/sql-wasm.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load sql.js"));
    document.head.appendChild(script);
  });
  SQL = await initSqlJs({
    locateFile: (file) => `https://sql.js.org/dist/${file}`
  });
  return SQL;
}
var SQLLayer = class {
  db = null;
  tableSchemas = /* @__PURE__ */ new Map();
  async init(data) {
    const sqlJs = await loadSqlJs();
    this.db = data ? new sqlJs.Database(data) : new sqlJs.Database();
    this.db.run("PRAGMA foreign_keys = ON");
  }
  getDb() {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }
  /**
   * Execute SQL and extract operations for mutations
   */
  execute(sql, params, hlc) {
    const db = this.getDb();
    const operations = [];
    const normalizedSql = sql.trim().toUpperCase();
    if (normalizedSql.startsWith("INSERT") && hlc) {
      const op = this.captureInsert(sql, params || [], hlc);
      if (op) operations.push(op);
    } else if (normalizedSql.startsWith("UPDATE") && hlc) {
      const ops = this.captureUpdate(sql, params || [], hlc);
      operations.push(...ops);
    } else if (normalizedSql.startsWith("DELETE") && hlc) {
      const ops = this.captureDelete(sql, params || [], hlc);
      operations.push(...ops);
    }
    const stmt = db.prepare(sql);
    if (params) {
      stmt.bind(params);
    }
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.get());
    }
    stmt.free();
    if (normalizedSql.startsWith("CREATE") || normalizedSql.startsWith("ALTER")) {
      this.refreshSchemas();
    }
    return {
      result: {
        columns,
        rows,
        changes: db.getRowsModified()
      },
      operations
    };
  }
  /**
   * Apply a remote operation to the database
   */
  applyOperation(op) {
    const db = this.getDb();
    switch (op.type) {
      case "INSERT": {
        const cols = Object.keys(op.values || {});
        const placeholders = cols.map(() => "?").join(", ");
        const sql = `INSERT OR REPLACE INTO ${op.table} (${cols.join(", ")}) VALUES (${placeholders})`;
        db.run(sql, Object.values(op.values || {}));
        break;
      }
      case "UPDATE": {
        const sets = Object.keys(op.values || {}).map((col) => `${col} = ?`).join(", ");
        const wheres = Object.keys(op.pk).map((col) => `${col} = ?`).join(" AND ");
        const sql = `UPDATE ${op.table} SET ${sets} WHERE ${wheres}`;
        db.run(sql, [...Object.values(op.values || {}), ...Object.values(op.pk)]);
        break;
      }
      case "DELETE": {
        const wheres = Object.keys(op.pk).map((col) => `${col} = ?`).join(" AND ");
        const sql = `DELETE FROM ${op.table} WHERE ${wheres}`;
        db.run(sql, Object.values(op.pk));
        break;
      }
    }
  }
  /**
   * Export database as binary
   */
  export() {
    return this.getDb().export();
  }
  /**
   * Import database from binary
   */
  import(data) {
    if (!SQL) throw new Error("SQL.js not initialized");
    this.db?.close();
    this.db = new SQL.Database(data);
    this.refreshSchemas();
  }
  close() {
    this.db?.close();
    this.db = null;
  }
  // Schema introspection
  refreshSchemas() {
    this.tableSchemas.clear();
    const db = this.getDb();
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    if (!tables[0]) return;
    for (const row of tables[0].values) {
      const tableName = row[0];
      const info = db.exec(`PRAGMA table_info(${tableName})`);
      if (info[0]) {
        const columns = [];
        let pkColumns = [];
        for (const col of info[0].values) {
          const colInfo = {
            name: col[1],
            type: col[2],
            notNull: col[3] === 1,
            defaultValue: col[4],
            pk: col[5] > 0
          };
          columns.push(colInfo);
          if (colInfo.pk) {
            pkColumns.push(colInfo.name);
          }
        }
        this.tableSchemas.set(tableName, { columns, pkColumns });
      }
    }
  }
  getTableSchema(table) {
    if (this.tableSchemas.size === 0) {
      this.refreshSchemas();
    }
    return this.tableSchemas.get(table);
  }
  // Operation capture helpers
  captureInsert(sql, params, hlc) {
    const match = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i);
    if (!match) return null;
    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return null;
    const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) return null;
    const columns = colMatch[1].split(",").map((c) => c.trim());
    const values = {};
    const pk = {};
    columns.forEach((col, i) => {
      values[col] = params[i];
      if (schema.pkColumns.includes(col)) {
        pk[col] = params[i];
      }
    });
    return { hlc, type: "INSERT", table, pk, values };
  }
  captureUpdate(sql, params, hlc) {
    const match = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!match) return [];
    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return [];
    const whereMatch = sql.match(/WHERE\s+(.+)$/i);
    const wherePart = whereMatch ? whereMatch[1] : "1=1";
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i) || sql.match(/SET\s+(.+)$/i);
    if (!setMatch) return [];
    const setCols = setMatch[1].split(",").map((s) => s.split("=")[0].trim());
    const setParamCount = setCols.length;
    const whereParams = params.slice(setParamCount);
    const selectSql = `SELECT ${schema.pkColumns.join(", ")} FROM ${table} WHERE ${wherePart}`;
    const db = this.getDb();
    const stmt = db.prepare(selectSql);
    stmt.bind(whereParams);
    const operations = [];
    while (stmt.step()) {
      const pkValues = stmt.get();
      const pk = {};
      schema.pkColumns.forEach((col, i) => {
        pk[col] = pkValues[i];
      });
      const values = {};
      setCols.forEach((col, i) => {
        values[col] = params[i];
      });
      operations.push({ hlc, type: "UPDATE", table, pk, values });
    }
    stmt.free();
    return operations;
  }
  captureDelete(sql, params, hlc) {
    const match = sql.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!match) return [];
    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return [];
    const whereMatch = sql.match(/WHERE\s+(.+)$/i);
    const wherePart = whereMatch ? whereMatch[1] : "1=1";
    const selectSql = `SELECT ${schema.pkColumns.join(", ")} FROM ${table} WHERE ${wherePart}`;
    const db = this.getDb();
    const stmt = db.prepare(selectSql);
    stmt.bind(params);
    const operations = [];
    while (stmt.step()) {
      const pkValues = stmt.get();
      const pk = {};
      schema.pkColumns.forEach((col, i) => {
        pk[col] = pkValues[i];
      });
      operations.push({ hlc, type: "DELETE", table, pk });
    }
    stmt.free();
    return operations;
  }
};

// src/storage.ts
var DB_VERSION = 1;
var Storage = class {
  dbName;
  db = null;
  constructor(dbName) {
    this.dbName = dbName;
  }
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("database")) {
          db.createObjectStore("database");
        }
        if (!db.objectStoreNames.contains("operations")) {
          const opStore = db.createObjectStore("operations", { keyPath: "id" });
          opStore.createIndex("table", "table", { unique: false });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }
  getDb() {
    if (!this.db) throw new Error("Database not opened");
    return this.db;
  }
  // Database file operations
  async saveDatabase(data) {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("database", "readwrite");
      const store = tx.objectStore("database");
      const request = store.put(data, "main");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  async loadDatabase() {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("database", "readonly");
      const store = tx.objectStore("database");
      const request = store.get("main");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }
  // Operations log
  async saveOperation(op) {
    const stored = {
      ...op,
      id: HybridClock.toString(op.hlc)
    };
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("operations", "readwrite");
      const store = tx.objectStore("operations");
      const request = store.put(stored);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  async getOperations(afterId) {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("operations", "readonly");
      const store = tx.objectStore("operations");
      const range = afterId ? IDBKeyRange.lowerBound(afterId, true) : void 0;
      const request = store.getAll(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  async getOperationCount() {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("operations", "readonly");
      const store = tx.objectStore("operations");
      const request = store.count();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  // Metadata
  async saveMeta(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const request = store.put(value, key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  async getMeta(key) {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }
  close() {
    this.db?.close();
    this.db = null;
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
  signalingUrl = "";
  token = "";
  // Callbacks
  onOperation = null;
  onSyncRequest = null;
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
    this.signalingUrl = signalingUrl;
    this.token = token;
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
    const peerConn = { pc, dc: null, ready: false };
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
      const localVersion = this.getLocalVersion?.();
      this.sendToPeer(peerId, { type: "sync-request", fromVersion: peerConn.lastSyncedVersion });
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
  handleChannelMessage(msg, fromPeerId, peerConn) {
    switch (msg.type) {
      case "op":
        this.onOperation?.(msg.payload, fromPeerId);
        if (msg.version) {
          peerConn.lastSyncedVersion = msg.version;
        }
        break;
      case "sync-request":
        const ops = this.onSyncRequest?.(fromPeerId, msg.fromVersion) || [];
        const version = this.getLocalVersion?.();
        this.sendToPeer(fromPeerId, { type: "sync-response", operations: ops, version });
        break;
      case "sync-response":
        for (const op of msg.operations) {
          this.onOperation?.(op, fromPeerId);
        }
        if (msg.version) {
          peerConn.lastSyncedVersion = msg.version;
        }
        break;
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
   * Broadcast operation to all connected peers with version info
   */
  broadcast(op) {
    const version = HybridClock.toString(op.hlc);
    const message = { type: "op", payload: op, version };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === "open") {
        peer.dc.send(JSON.stringify(message));
        peer.lastSyncedVersion = version;
      }
    }
  }
  /**
   * Request sync from all peers
   */
  requestSync(fromVersion) {
    const message = { type: "sync-request", fromVersion };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === "open") {
        peer.dc.send(JSON.stringify(message));
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
  sql;
  storage;
  clock;
  webrtc = null;
  initialized = false;
  connected = false;
  saveTimeout = null;
  eventListeners = /* @__PURE__ */ new Map();
  // Cache for sync responses (sync callback can't be async)
  operationsCache = [];
  operationsCacheVersion;
  constructor(config = {}) {
    this.config = {
      dbName: "rtc-battery-default",
      ...config
    };
    this.sql = new SQLLayer();
    this.storage = new Storage(this.config.dbName);
    this.clock = new HybridClock();
  }
  /**
   * Initialize the database (local only)
   */
  async init() {
    if (this.initialized) return;
    await this.storage.open();
    const existingData = await this.storage.loadDatabase();
    await this.sql.init(existingData || void 0);
    this.initialized = true;
    await this.updateOperationsCache();
    this.scheduleSave();
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
    this.webrtc = new WebRTCManager(this.clock.getNodeId(), this.config.iceServers);
    this.webrtc.onOperation = async (op, fromPeerId) => {
      await this.applyRemoteOperation(op);
      this.emit("operation", op, fromPeerId);
    };
    this.webrtc.onSyncRequest = (fromPeerId, fromVersion) => {
      return this.getCachedOperations(fromVersion);
    };
    this.webrtc.getLocalVersion = () => {
      return this.operationsCacheVersion;
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
    this.emit("connected");
  }
  getCachedOperations(fromVersion) {
    if (!fromVersion) {
      return this.operationsCache;
    }
    const index = this.operationsCache.findIndex((op) => {
      return HybridClock.toString(op.hlc) === fromVersion;
    });
    if (index === -1) {
      return this.operationsCache;
    }
    return this.operationsCache.slice(index + 1);
  }
  async updateOperationsCache() {
    this.operationsCache = await this.storage.getOperations();
    if (this.operationsCache.length > 0) {
      const lastOp = this.operationsCache[this.operationsCache.length - 1];
      this.operationsCacheVersion = HybridClock.toString(lastOp.hlc);
    } else {
      this.operationsCacheVersion = void 0;
    }
  }
  /**
   * Execute SQL query
   * Mutations are automatically tracked as operations and synced to peers
   */
  async exec(sql, params) {
    this.ensureInitialized();
    const isMutation = this.isMutation(sql);
    const hlc = isMutation ? this.clock.now() : void 0;
    const { result, operations } = this.sql.execute(sql, params, hlc);
    for (const op of operations) {
      await this.storage.saveOperation(op);
      this.emit("operation", op);
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
  async execLocal(sql, params) {
    this.ensureInitialized();
    const { result } = this.sql.execute(sql, params);
    return result;
  }
  /**
   * Apply a remote operation (from another peer)
   */
  async applyRemoteOperation(op) {
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
  async getOperationsAfter(afterHlc) {
    return this.storage.getOperations(afterHlc);
  }
  /**
   * Get current operation count
   */
  async getOperationCount() {
    return this.storage.getOperationCount();
  }
  /**
   * Get current version (HLC string of last operation)
   */
  getVersion() {
    return this.operationsCacheVersion;
  }
  /**
   * Export database as binary
   */
  exportDatabase() {
    this.ensureInitialized();
    return this.sql.export();
  }
  /**
   * Import database from binary
   */
  importDatabase(data) {
    this.ensureInitialized();
    this.sql.import(data);
    this.scheduleSave();
  }
  /**
   * Get local node ID
   */
  getNodeId() {
    return this.clock.getNodeId();
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
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      await this.saveDatabase();
    }
    this.sql.close();
    this.storage.close();
    this.initialized = false;
  }
  ensureInitialized() {
    if (!this.initialized) {
      throw new Error("RTCBattery not initialized. Call init() first.");
    }
  }
  isMutation(sql) {
    const normalized = sql.trim().toUpperCase();
    return normalized.startsWith("INSERT") || normalized.startsWith("UPDATE") || normalized.startsWith("DELETE");
  }
  scheduleSave() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.saveDatabase();
    }, 1e3);
  }
  async saveDatabase() {
    try {
      const data = this.sql.export();
      await this.storage.saveDatabase(data);
    } catch (e) {
      console.error("Failed to save database:", e);
      this.emit("error", e);
    }
  }
};
export {
  HybridClock,
  RTCBattery
};
