/**
 * 纯 JSON HTTP API（无第三方框架）。只做后端，不提供任何页面。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { ReportStore, type ReportRecord } from './db.js';
import { RULE_VERSION } from './limits.js';
import { runBatch, runTransform, type Direction } from './runner.js';
import type { Mode } from './service.js';

export interface StartServerOptions {
  /** 0 表示由操作系统分配空闲端口（默认）。 */
  port?: number;
  host?: string;
  store?: ReportStore;
}

const VALID_MODES = new Set(['raw', 'ace']);

export function createApiServer(store?: ReportStore): Server {
  return createServer((req, res) => {
    handle(req, res, store).catch((err) => {
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err as Error).message } });
    });
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<{ server: Server; port: number; close: () => void }> {
  const server = createApiServer(options.store);
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () => server.close(),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, store?: ReportStore): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, ruleVersion: RULE_VERSION });
    return;
  }

  if (req.method === 'GET' && path === '/api/reports') {
    if (!store) return sendJson(res, 404, { ok: false, error: { code: 'STORAGE_DISABLED', message: '未启用 SQLite 存储' } });
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
    const offset = clampInt(url.searchParams.get('offset'), 0, 100000, 0);
    const records = store.list(limit, offset).map(parseRecord);
    sendJson(res, 200, { ok: true, ruleVersion: RULE_VERSION, limit, offset, reports: records });
    return;
  }

  if (req.method === 'GET' && path === '/api/reports/export.json') {
    // 放在 /:id 之前匹配；直接导出全部（上限 2000 条）。
    if (!store) return sendJson(res, 404, { ok: false, error: { code: 'STORAGE_DISABLED', message: '未启用 SQLite 存储' } });
    const records = store.list(2000, 0).map(parseRecord);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="punycode-reports.json"',
    });
    res.end(JSON.stringify({ ok: true, ruleVersion: RULE_VERSION, exportedAt: new Date().toISOString(), reports: records }, null, 2));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/reports/')) {
    if (!store) return sendJson(res, 404, { ok: false, error: { code: 'STORAGE_DISABLED', message: '未启用 SQLite 存储' } });
    const id = Number(path.slice('/api/reports/'.length));
    if (!Number.isInteger(id) || id <= 0) {
      return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '报告 id 必须是正整数' } });
    }
    const record = store.get(id);
    if (!record) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `报告 ${id} 不存在` } });
    sendJson(res, 200, { ok: true, report: parseRecord(record) });
    return;
  }

  const singleRoute = matchTransformRoute(req.method, path, false);
  const batchRoute = matchTransformRoute(req.method, path, true);

  if (singleRoute || batchRoute) {
    const body = await readJsonBody(req);
    if ('error' in body) return sendJson(res, 400, { ok: false, error: body.error });

    if (singleRoute) {
      const value = (body.input ?? body.value) as unknown;
      const mode = parseMode(body.mode);
      if (typeof mode !== 'string') return sendJson(res, 400, { ok: false, error: mode });
      if (typeof value !== 'string') {
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '字段 input 必须是字符串' } });
      }
      const explain = path.endsWith('/explain');
      const response = runTransform(store, singleRoute, value, mode, explain || body.includeSteps === true);
      return sendJson(res, response.ok ? 200 : 422, response);
    }

    if (batchRoute) {
      const items = body.items as unknown;
      const mode = parseMode(body.mode);
      if (typeof mode !== 'string') return sendJson(res, 400, { ok: false, error: mode });
      if (!Array.isArray(items)) {
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '字段 items 必须是数组' } });
      }
      if (items.length === 0) {
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '批量 items 不能为空' } });
      }
      if (items.length > 500) {
        return sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: '单次批量最多 500 条' } });
      }
      const response = runBatch(store, batchRoute, items as { input: string; mode?: Mode }[], mode, body.includeSteps === true);
      return sendJson(res, response.ok ? 200 : 207, response);
    }
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `没有 ${req.method} ${path} 路由` } });
}

function matchTransformRoute(method: string | undefined, path: string, batch: boolean): Direction | undefined {
  if (method !== 'POST') return undefined;
  const suffix = batch ? '/batch' : '';
  if (path === `/api/encode${suffix}`) return 'encode';
  if (path === `/api/decode${suffix}`) return 'decode';
  if (!batch && (path === '/api/encode/explain' || path === '/api/decode/explain')) {
    return path.startsWith('/api/encode') ? 'encode' : 'decode';
  }
  return undefined;
}

function parseMode(value: unknown): Mode | { code: 'INVALID_ARGUMENT'; message: string } {
  if (value === undefined) return 'raw';
  if (typeof value === 'string' && VALID_MODES.has(value)) return value as Mode;
  return { code: 'INVALID_ARGUMENT', message: 'mode 只能是 raw 或 ace' };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | { error: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 2 * 1024 * 1024) {
      return { error: { code: 'INVALID_ARGUMENT', message: '请求体超过 2 MiB 限制' } };
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return { error: { code: 'INVALID_ARGUMENT', message: '缺少 JSON 请求体' } };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: { code: 'INVALID_ARGUMENT', message: 'JSON 请求体必须是对象' } };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { error: { code: 'INVALID_ARGUMENT', message: 'JSON 解析失败' } };
  }
}

function parseRecord(record: ReportRecord) {
  return {
    ...record,
    result: record.result_json ? JSON.parse(record.result_json) : null,
    error: record.error_json ? JSON.parse(record.error_json) : null,
    result_json: undefined,
    error_json: undefined,
  };
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
