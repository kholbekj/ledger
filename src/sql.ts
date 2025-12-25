import type { HLC } from './hlc';
import type { Operation, QueryResult } from './types';

// sql.js types
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
}

interface Database {
  run(sql: string, params?: unknown[]): Database;
  exec(sql: string, params?: unknown[]): QueryExecResult[];
  prepare(sql: string): Statement;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}

interface Statement {
  bind(params?: unknown[]): boolean;
  step(): boolean;
  get(): unknown[];
  getColumnNames(): string[];
  free(): boolean;
}

interface QueryExecResult {
  columns: string[];
  values: unknown[][];
}

declare global {
  function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}

let SQL: SqlJsStatic | null = null;

/**
 * Load sql.js from CDN
 */
async function loadSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL;

  // Check if already loaded globally
  if (typeof initSqlJs !== 'undefined') {
    SQL = await initSqlJs({
      locateFile: (file: string) => `https://sql.js.org/dist/${file}`
    });
    return SQL;
  }

  // Load script dynamically
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sql.js.org/dist/sql-wasm.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load sql.js'));
    document.head.appendChild(script);
  });

  SQL = await initSqlJs({
    locateFile: (file: string) => `https://sql.js.org/dist/${file}`
  });
  return SQL;
}

/**
 * SQL Layer wrapping sql.js with operation extraction
 */
export class SQLLayer {
  private db: Database | null = null;
  private tableSchemas: Map<string, TableSchema> = new Map();

  async init(data?: Uint8Array): Promise<void> {
    const sqlJs = await loadSqlJs();
    this.db = data ? new sqlJs.Database(data) : new sqlJs.Database();

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');
  }

  private getDb(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  /**
   * Execute SQL and extract operations for mutations
   */
  execute(sql: string, params?: unknown[], hlc?: HLC): {
    result: QueryResult;
    operations: Operation[];
  } {
    const db = this.getDb();
    const operations: Operation[] = [];
    const normalizedSql = sql.trim().toUpperCase();

    // Detect mutation type
    if (normalizedSql.startsWith('INSERT') && hlc) {
      const op = this.captureInsert(sql, params || [], hlc);
      if (op) operations.push(op);
    } else if (normalizedSql.startsWith('UPDATE') && hlc) {
      const ops = this.captureUpdate(sql, params || [], hlc);
      operations.push(...ops);
    } else if (normalizedSql.startsWith('DELETE') && hlc) {
      const ops = this.captureDelete(sql, params || [], hlc);
      operations.push(...ops);
    }

    // Execute the actual SQL
    const stmt = db.prepare(sql);
    if (params) {
      stmt.bind(params);
    }

    const columns: string[] = stmt.getColumnNames();
    const rows: unknown[][] = [];

    while (stmt.step()) {
      rows.push(stmt.get());
    }
    stmt.free();

    // Refresh schema cache if DDL
    if (normalizedSql.startsWith('CREATE') || normalizedSql.startsWith('ALTER')) {
      this.refreshSchemas();
    }

    return {
      result: {
        columns,
        rows,
        changes: db.getRowsModified(),
      },
      operations
    };
  }

  /**
   * Apply a remote operation to the database
   */
  applyOperation(op: Operation): void {
    const db = this.getDb();

    switch (op.type) {
      case 'INSERT': {
        const cols = Object.keys(op.values || {});
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT OR REPLACE INTO ${op.table} (${cols.join(', ')}) VALUES (${placeholders})`;
        db.run(sql, Object.values(op.values || {}));
        break;
      }
      case 'UPDATE': {
        const sets = Object.keys(op.values || {})
          .map(col => `${col} = ?`)
          .join(', ');
        const wheres = Object.keys(op.pk)
          .map(col => `${col} = ?`)
          .join(' AND ');
        const sql = `UPDATE ${op.table} SET ${sets} WHERE ${wheres}`;
        db.run(sql, [...Object.values(op.values || {}), ...Object.values(op.pk)]);
        break;
      }
      case 'DELETE': {
        const wheres = Object.keys(op.pk)
          .map(col => `${col} = ?`)
          .join(' AND ');
        const sql = `DELETE FROM ${op.table} WHERE ${wheres}`;
        db.run(sql, Object.values(op.pk));
        break;
      }
    }
  }

  /**
   * Export database as binary
   */
  export(): Uint8Array {
    return this.getDb().export();
  }

  /**
   * Import database from binary
   */
  import(data: Uint8Array): void {
    if (!SQL) throw new Error('SQL.js not initialized');
    this.db?.close();
    this.db = new SQL.Database(data);
    this.refreshSchemas();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // Schema introspection

  private refreshSchemas(): void {
    this.tableSchemas.clear();
    const db = this.getDb();

    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );

    if (!tables[0]) return;

    for (const row of tables[0].values) {
      const tableName = row[0] as string;
      const info = db.exec(`PRAGMA table_info(${tableName})`);

      if (info[0]) {
        const columns: ColumnInfo[] = [];
        let pkColumns: string[] = [];

        for (const col of info[0].values) {
          const colInfo: ColumnInfo = {
            name: col[1] as string,
            type: col[2] as string,
            notNull: col[3] === 1,
            defaultValue: col[4],
            pk: (col[5] as number) > 0
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

  getTableSchema(table: string): TableSchema | undefined {
    if (this.tableSchemas.size === 0) {
      this.refreshSchemas();
    }
    return this.tableSchemas.get(table);
  }

  // Operation capture helpers

  private captureInsert(sql: string, params: unknown[], hlc: HLC): Operation | null {
    // Parse table name from INSERT INTO table_name
    const match = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i);
    if (!match) return null;

    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return null;

    // Parse column names
    const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) return null;

    const columns = colMatch[1].split(',').map(c => c.trim());
    const values: Record<string, unknown> = {};
    const pk: Record<string, unknown> = {};

    columns.forEach((col, i) => {
      values[col] = params[i];
      if (schema.pkColumns.includes(col)) {
        pk[col] = params[i];
      }
    });

    return { hlc, type: 'INSERT', table, pk, values };
  }

  private captureUpdate(sql: string, params: unknown[], hlc: HLC): Operation[] {
    // Parse table name
    const match = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!match) return [];

    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return [];

    // Get rows that will be affected (before update)
    const whereMatch = sql.match(/WHERE\s+(.+)$/i);
    const wherePart = whereMatch ? whereMatch[1] : '1=1';

    // Parse SET clause to find column count
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i) || sql.match(/SET\s+(.+)$/i);
    if (!setMatch) return [];

    const setCols = setMatch[1].split(',').map(s => s.split('=')[0].trim());
    const setParamCount = setCols.length;
    const whereParams = params.slice(setParamCount);

    // Get affected rows
    const selectSql = `SELECT ${schema.pkColumns.join(', ')} FROM ${table} WHERE ${wherePart}`;
    const db = this.getDb();
    const stmt = db.prepare(selectSql);
    stmt.bind(whereParams);

    const operations: Operation[] = [];
    while (stmt.step()) {
      const pkValues = stmt.get();
      const pk: Record<string, unknown> = {};
      schema.pkColumns.forEach((col, i) => {
        pk[col] = pkValues[i];
      });

      const values: Record<string, unknown> = {};
      setCols.forEach((col, i) => {
        values[col] = params[i];
      });

      operations.push({ hlc, type: 'UPDATE', table, pk, values });
    }
    stmt.free();

    return operations;
  }

  private captureDelete(sql: string, params: unknown[], hlc: HLC): Operation[] {
    // Parse table name
    const match = sql.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!match) return [];

    const table = match[1];
    const schema = this.getTableSchema(table);
    if (!schema || schema.pkColumns.length === 0) return [];

    // Get rows that will be deleted
    const whereMatch = sql.match(/WHERE\s+(.+)$/i);
    const wherePart = whereMatch ? whereMatch[1] : '1=1';

    const selectSql = `SELECT ${schema.pkColumns.join(', ')} FROM ${table} WHERE ${wherePart}`;
    const db = this.getDb();
    const stmt = db.prepare(selectSql);
    stmt.bind(params);

    const operations: Operation[] = [];
    while (stmt.step()) {
      const pkValues = stmt.get();
      const pk: Record<string, unknown> = {};
      schema.pkColumns.forEach((col, i) => {
        pk[col] = pkValues[i];
      });

      operations.push({ hlc, type: 'DELETE', table, pk });
    }
    stmt.free();

    return operations;
  }
}

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: unknown;
  pk: boolean;
}

interface TableSchema {
  columns: ColumnInfo[];
  pkColumns: string[];
}
