/**
 * SQLite 报告存储（Node 内置 node:sqlite，无需第三方库）。
 * 报告一经写入不可变：改变模式或重新转换只会新增记录，旧报告保持当时结果。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RULE_VERSION } from './limits.js';

export interface ReportRecord {
  id: number;
  created_at: string;
  direction: 'encode' | 'decode';
  mode: 'raw' | 'ace';
  rule_version: string;
  input: string;
  success: 0 | 1;
  result_json: string;
  error_json: string | null;
}

export class ReportStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        direction TEXT NOT NULL CHECK (direction IN ('encode','decode')),
        mode TEXT NOT NULL CHECK (mode IN ('raw','ace')),
        rule_version TEXT NOT NULL,
        input TEXT NOT NULL,
        success INTEGER NOT NULL CHECK (success IN (0,1)),
        result_json TEXT NOT NULL,
        error_json TEXT
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(id DESC);');
  }

  save(params: {
    direction: 'encode' | 'decode';
    mode: 'raw' | 'ace';
    input: string;
    success: boolean;
    result: unknown;
    error?: unknown;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO reports (direction, mode, rule_version, input, success, result_json, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      params.direction,
      params.mode,
      RULE_VERSION,
      params.input,
      params.success ? 1 : 0,
      JSON.stringify(params.result ?? null),
      params.error === undefined ? null : JSON.stringify(params.error),
    );
    return Number(info.lastInsertRowid);
  }

  list(limit = 50, offset = 0): ReportRecord[] {
    const stmt = this.db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT ? OFFSET ?');
    return stmt.all(limit, offset) as unknown as ReportRecord[];
  }

  get(id: number): ReportRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM reports WHERE id = ?');
    return stmt.get(id) as unknown as ReportRecord | undefined;
  }

  close(): void {
    this.db.close();
  }
}
