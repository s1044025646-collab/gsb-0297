import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { OpReport } from "./service";

export class ReportStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(process.cwd(), "data", "punycode.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        op TEXT NOT NULL,
        mode TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        input TEXT NOT NULL,
        ok INTEGER NOT NULL,
        report TEXT NOT NULL
      );
    `);
  }

  save(report: OpReport): number {
    const stmt = this.db.prepare(
      `INSERT INTO reports (op, mode, rules_version, input, ok, report)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const res = stmt.run(
      report.op,
      report.mode,
      report.rulesVersion,
      report.input,
      report.ok ? 1 : 0,
      JSON.stringify(report)
    );
    return Number(res.lastInsertRowid);
  }

  list(limit = 50, offset = 0): unknown[] {
    const rows = this.db
      .prepare(`SELECT id, created_at, op, mode, rules_version, input, ok, report FROM reports ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as any[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      op: r.op,
      mode: r.mode,
      rulesVersion: r.rules_version,
      input: r.input,
      ok: !!r.ok,
      report: JSON.parse(r.report),
    }));
  }

  get(id: number): unknown | null {
    const r = this.db
      .prepare(`SELECT id, created_at, op, mode, rules_version, input, ok, report FROM reports WHERE id = ?`)
      .get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      createdAt: r.created_at,
      op: r.op,
      mode: r.mode,
      rulesVersion: r.rules_version,
      input: r.input,
      ok: !!r.ok,
      report: JSON.parse(r.report),
    };
  }

  close() {
    this.db.close();
  }
}
