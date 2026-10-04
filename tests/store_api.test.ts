import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ReportStore } from '../src/db.js';
import { RULE_VERSION } from '../src/limits.js';
import { runBatch, runTransform } from '../src/runner.js';
import { createApiServer, startServer } from '../src/server.js';
import type { Server } from 'node:http';

describe('SQLite 报告存储', () => {
  let store: ReportStore;
  let dbPath: string;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'puny-test-'));
    dbPath = join(dir, 'reports.db');
    store = new ReportStore(dbPath);
  });

  after(() => store.close());

  it('成功与失败都落库，含规则版本', () => {
    const ok = runTransform(store, 'encode', 'bücher', 'raw', false);
    const bad = runTransform(store, 'encode', '', 'ace', false);
    assert.equal(ok.ok, true);
    assert.equal(bad.ok, false);
    assert.ok(ok.reportId);
    assert.ok(bad.reportId);
    const rows = store.list(10, 0);
    assert.equal(rows.length >= 2, true);
    assert.equal(rows[0]!.rule_version, RULE_VERSION);
    assert.equal(rows[0]!.success, 0);
  });

  it('改变模式新增记录而不覆盖旧报告', () => {
    const raw = runTransform(store, 'encode', 'bücher', 'raw', false);
    const ace = runTransform(store, 'encode', 'bücher', 'ace', false);
    assert.notEqual(raw.reportId, ace.reportId);
    const rawRow = store.get(raw.reportId!)!;
    const aceRow = store.get(ace.reportId!)!;
    assert.equal(rawRow.mode, 'raw');
    assert.equal(aceRow.mode, 'ace');
    assert.equal(rawRow.result_json.includes('bcher-kva'), true);
    assert.equal(aceRow.result_json.includes('xn--bcher-kva'), true);
  });

  it('重新打开数据库后历史仍可读（持久化）', () => {
    store.close();
    const reopened = new ReportStore(dbPath);
    const rows = reopened.list(100, 0);
    assert.ok(rows.length >= 4);
    reopened.close();
    store = new ReportStore(dbPath);
  });
});

describe('批量逐项定位', () => {
  it('失败条目不跳过，返回每项 index 与错误位置', () => {
    const result = runBatch(
      undefined,
      'encode',
      [{ input: 'bücher' }, { input: 'a' + String.fromCharCode(0xd800) }, { input: '中文' }],
      'raw',
      false,
    );
    assert.equal(result.ok, false);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0]!.ok, true);
    assert.equal(result.items[1]!.ok, false);
    assert.equal(result.items[1]!.index, 1);
    assert.equal(result.items[1]!.error!.code, 'LONE_SURROGATE');
    assert.equal(result.items[1]!.error!.position, 1);
    assert.equal(result.items[2]!.ok, true);
  });

  it('全部成功时 ok=true', () => {
    const result = runBatch(
      undefined,
      'decode',
      [{ input: 'bcher-kva' }, { input: 'e28h' }],
      'raw',
      false,
    );
    assert.equal(result.ok, true);
    assert.equal(result.failed, 0);
  });
});

describe('HTTP API', () => {
  let port: number;
  let close: () => void;
  let server: Server;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puny-api-'));
    const store = new ReportStore(join(dir, 'api.db'));
    server = createApiServer(store);
    const started = await startServer({ port: 0, store });
    server = started.server;
    port = started.port;
    close = started.close;
  });

  after(() => close());

  async function call(path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  }

  it('GET /health', async () => {
    const { status, json } = await call('/health');
    assert.equal(status, 200);
    assert.equal(json.ruleVersion, RULE_VERSION);
  });

  it('POST /api/encode 与解码一致', async () => {
    const enc = await call('/api/encode', { input: 'bücher' });
    assert.equal(enc.status, 200);
    assert.equal(enc.json.result.punycode, 'bcher-kva');
    const dec = await call('/api/decode', { input: 'bcher-kva' });
    assert.equal(dec.json.result.output, 'bücher');
  });

  it('POST /api/encode/explain 含步骤与码点表', async () => {
    const { json } = await call('/api/encode/explain', { input: 'mañana' });
    assert.equal(json.result.steps.length, 1);
    assert.ok(Array.isArray(json.result.codePoints));
  });

  it('ACE 空标签返回 422 与 EMPTY_ACE_LABEL', async () => {
    const { status, json } = await call('/api/encode', { input: '', mode: 'ace' });
    assert.equal(status, 422);
    assert.equal(json.error.code, 'EMPTY_ACE_LABEL');
  });

  it('批量混合结果返回 207，逐项带 index', async () => {
    const { status, json } = await call('/api/encode/batch', {
      items: [{ input: 'a' }, { input: '' , mode: 'ace'}],
    });
    assert.equal(status, 207);
    assert.equal(json.items[1].error.code, 'EMPTY_ACE_LABEL');
  });

  it('非法 JSON 返回 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(res.status, 400);
  });

  it('历史接口与导出 JSON 可读', async () => {
    const history = await call('/api/reports?limit=5');
    assert.equal(history.status, 200);
    assert.ok(history.json.reports.length >= 1);
    const exported = await call('/api/reports/export.json');
    assert.equal(exported.status, 200);
    assert.ok(Array.isArray(exported.json.reports));
  });
});
