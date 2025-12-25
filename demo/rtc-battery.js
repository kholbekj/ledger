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

// src/index.ts
var RTCBattery = class {
  config;
  sql;
  storage;
  clock;
  initialized = false;
  saveTimeout = null;
  eventListeners = /* @__PURE__ */ new Map();
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
   * Initialize the database
   */
  async init() {
    if (this.initialized) return;
    await this.storage.open();
    const existingData = await this.storage.loadDatabase();
    await this.sql.init(existingData || void 0);
    this.initialized = true;
    this.scheduleSave();
  }
  /**
   * Execute SQL query
   * Mutations are automatically tracked as operations
   */
  async exec(sql, params) {
    this.ensureInitialized();
    const isMutation = this.isMutation(sql);
    const hlc = isMutation ? this.clock.now() : void 0;
    const { result, operations } = this.sql.execute(sql, params, hlc);
    for (const op of operations) {
      await this.storage.saveOperation(op);
      this.emit("operation", op);
    }
    if (operations.length > 0) {
      this.scheduleSave();
    }
    return result;
  }
  /**
   * Execute SQL without CRDT tracking (local only)
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
   * Close and cleanup
   */
  async close() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      await this.saveDatabase();
    }
    this.sql.close();
    this.storage.close();
    this.initialized = false;
  }
  // Private helpers
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
