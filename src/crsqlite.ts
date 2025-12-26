/**
 * cr-sqlite wrapper for CRDT-enabled SQLite
 */

// Raw change from cr-sqlite (with Uint8Array)
interface CRChangeRaw {
  table: string;
  pk: Uint8Array;
  cid: string;
  val: unknown;
  col_version: number;
  db_version: number;
  site_id: Uint8Array;
  cl: number;
  seq: number;
}

// Serializable change for WebRTC transport (base64 for binary fields)
export interface CRChange {
  table: string;
  pk: string; // base64 encoded
  cid: string;
  val: unknown;
  col_version: number;
  db_version: number;
  site_id: string; // base64 encoded
  cl: number;
  seq: number;
}

// Helper functions for base64 encoding/decoding Uint8Array
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

// Using 'any' for the cr-sqlite types since they're complex and async
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CrSqliteDB = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CrSqlite = any;

let sqliteInstance: CrSqlite | null = null;

/**
 * Load cr-sqlite WASM module
 */
async function loadCrSqlite(): Promise<CrSqlite> {
  if (sqliteInstance) return sqliteInstance;

  // Dynamic import for browser compatibility
  const initWasm = (await import('@vlcn.io/crsqlite-wasm')).default;
  sqliteInstance = await initWasm();
  return sqliteInstance;
}

/**
 * CRSQLite database wrapper
 */
export class CRSQLiteDB {
  private db: CrSqliteDB | null = null;
  private siteId: string = '';
  private dbVersion: number = 0;

  async open(dbName: string = ':memory:'): Promise<void> {
    const sqlite = await loadCrSqlite();
    this.db = await sqlite.open(dbName);

    // Get our site ID
    const result = await this.db.execA('SELECT crsql_site_id()');
    const siteIdBytes = result[0][0] as Uint8Array;
    this.siteId = Array.from(siteIdBytes as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join('');

    // Get current db version
    await this.refreshVersion();
  }

  private getDb(): CrSqliteDB {
    if (!this.db) throw new Error('Database not opened');
    return this.db;
  }

  private async refreshVersion(): Promise<void> {
    const result = await this.getDb().execA('SELECT crsql_db_version()');
    this.dbVersion = Number(result[0]?.[0] ?? 0);
  }

  /**
   * Execute SQL statement(s)
   */
  async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.getDb().exec(sql, params);
  }

  /**
   * Execute SQL and return results as objects
   */
  async execO<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.getDb().execO(sql, params);
    return (result ?? []) as T[];
  }

  /**
   * Execute SQL and return results as arrays
   */
  async execA<T = unknown[]>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.getDb().execA(sql, params);
    return (result ?? []) as T[];
  }

  /**
   * Execute SQL and return QueryResult format (for API compatibility)
   */
  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const objRows = await this.getDb().execO(sql, params);

    // Handle null/undefined or empty results
    if (!objRows || objRows.length === 0) {
      return { columns: [], rows: [] };
    }

    const columns = Object.keys(objRows[0]);
    const rows = objRows.map((row: Record<string, unknown>) => columns.map(col => row[col]));

    return { columns, rows };
  }

  /**
   * Enable CRDT tracking on a table
   */
  async enableCRR(tableName: string): Promise<void> {
    await this.getDb().exec(`SELECT crsql_as_crr('${tableName}')`);
  }

  /**
   * Get site ID as hex string
   */
  getSiteId(): string {
    if (!this.siteId) throw new Error('Database not opened');
    return this.siteId;
  }

  /**
   * Get current database version
   */
  getVersion(): number {
    return this.dbVersion;
  }

  /**
   * Get changes since a given version
   */
  async getChanges(sinceVersion: number = 0): Promise<CRChange[]> {
    await this.refreshVersion();

    const rows = await this.getDb().execO(
      `SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq"
       FROM crsql_changes
       WHERE db_version > ?`,
      [sinceVersion]
    ) as CRChangeRaw[];

    // Convert Uint8Array fields to base64 for JSON serialization
    return rows.map(row => ({
      ...row,
      pk: uint8ToBase64(row.pk),
      site_id: uint8ToBase64(row.site_id)
    }));
  }

  /**
   * Apply changes from another peer
   */
  async applyChanges(changes: CRChange[]): Promise<void> {
    const db = this.getDb();

    for (const change of changes) {
      // Convert base64 back to Uint8Array for cr-sqlite
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
  onUpdate(callback: (tableName: string, rowid: bigint) => void): () => void {
    return this.getDb().onUpdate((_type: number, _dbName: string, tblName: string, rowid: bigint) => {
      // Skip internal cr-sqlite tables
      if (!tblName.startsWith('crsql_') && !tblName.startsWith('__crsql_')) {
        callback(tblName, rowid);
      }
    });
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    if (this.db) {
      // Finalize cr-sqlite before closing
      await this.db.exec('SELECT crsql_finalize()');
      this.db.close();
      this.db = null;
    }
  }
}
