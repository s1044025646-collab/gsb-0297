#!/usr/bin/env node
/**
 * CLI：encode / decode / explain / batch / history / export / serve。
 * 与 HTTP API 共用同一套 runner，保证结果一致。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReportStore } from './db.js';
import { RULE_VERSION } from './limits.js';
import { runBatch, runTransform, type Direction } from './runner.js';
import { startServer } from './server.js';
import type { Mode } from './service.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

const HELP = `Punycode Bootstring 后端（RFC 3492，离线，无 DNS/IDNA）

用法:
  puny encode  <文本> [--mode raw|ace] [--no-store]
  puny decode  <ascii> [--mode raw|ace] [--no-store]
  puny explain <方向> <文本> [--mode raw|ace]   方向为 encode|decode
  puny batch   <方向> <items.json> [--mode raw|ace]
               items.json 为 [{"input":"..."}, ...]，逐项返回结果与错误位置
  puny history [--limit N] [--offset N]
  puny export  <out.json>                      导出全部历史报告为 JSON
  puny serve   [--port 0] [--host 127.0.0.1] [--db data/punycode.db]

说明:
  --mode raw  原始 Punycode；空串与纯 ASCII 均支持。
  --mode ace  仅添加/识别 xn-- 前缀；拒绝空标签。
  环境变量 PORT / PUNYCODE_DB 与同名参数等价。规则版本 ${RULE_VERSION}。
`;

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (key === 'no-store') {
        flags.set('no-store', '1');
      } else if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, '');
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function openStore(args: ParsedArgs): ReportStore | undefined {
  if (args.flags.has('no-store')) return undefined;
  const dbPath = resolve(args.flags.get('db') ?? process.env.PUNYCODE_DB ?? 'data/punycode.db');
  return new ReportStore(dbPath);
}

function modeOf(args: ParsedArgs): Mode {
  const mode = args.flags.get('mode') ?? 'raw';
  if (mode !== 'raw' && mode !== 'ace') {
    fail(`--mode 只能是 raw 或 ace，收到 "${mode}"`);
  }
  return mode;
}

function fail(message: string): never {
  process.stderr.write(`错误: ${message}\n`);
  process.exit(2);
}

function printJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = openStore(args);

  switch (args.command) {
    case '':
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'encode':
    case 'decode': {
      const input = args.positional[0];
      if (input === undefined) fail(`用法: puny ${args.command} <文本>`);
      printJson(runTransform(store, args.command as Direction, input, modeOf(args), false));
      break;
    }

    case 'explain': {
      const direction = args.positional[0];
      const input = args.positional[1];
      if (direction !== 'encode' && direction !== 'decode') fail('explain 方向必须是 encode 或 decode');
      if (input === undefined) fail('用法: puny explain <encode|decode> <文本>');
      printJson(runTransform(store, direction, input, modeOf(args), true));
      break;
    }

    case 'batch': {
      const direction = args.positional[0];
      const file = args.positional[1];
      if (direction !== 'encode' && direction !== 'decode') fail('batch 方向必须是 encode 或 decode');
      if (!file) fail('用法: puny batch <encode|decode> <items.json>');
      let items: unknown;
      try {
        items = JSON.parse(readFileSync(resolve(file), 'utf8'));
      } catch (err) {
        fail(`无法读取/解析批量文件: ${(err as Error).message}`);
      }
      if (!Array.isArray(items)) fail('items.json 顶层必须是数组');
      const response = runBatch(store, direction, items as { input: string }[], modeOf(args), false);
      printJson(response);
      if (!response.ok) process.exitCode = 1;
      break;
    }

    case 'history': {
      if (!store) fail('--no-store 模式下没有历史');
      const limit = Number(args.flags.get('limit') ?? '50');
      const offset = Number(args.flags.get('offset') ?? '0');
      const reports = store.list(Number.isFinite(limit) ? limit : 50, Number.isFinite(offset) ? offset : 0).map((r) => ({
        ...r,
        result: JSON.parse(r.result_json),
        error: r.error_json ? JSON.parse(r.error_json) : null,
      }));
      printJson({ ok: true, ruleVersion: RULE_VERSION, reports });
      break;
    }

    case 'export': {
      if (!store) fail('--no-store 模式下没有历史');
      const out = args.positional[0];
      if (!out) fail('用法: puny export <out.json>');
      const reports = store.list(2000, 0);
      writeFileSync(
        resolve(out),
        JSON.stringify({ ok: true, ruleVersion: RULE_VERSION, exportedAt: new Date().toISOString(), reports }, null, 2),
        'utf8',
      );
      process.stdout.write(`已导出 ${reports.length} 条报告到 ${out}\n`);
      break;
    }

    case 'serve': {
      const port = Number(args.flags.get('port') ?? process.env.PORT ?? '0') || 0;
      const host = args.flags.get('host') ?? '127.0.0.1';
      const started = await startServer({ port, host, store });
      process.stdout.write(
        `Punycode API 已启动: http://${host}:${started.port}  (规则 ${RULE_VERSION}, Ctrl+C 停止)\n`,
      );
      const shutdown = () => {
        started.close();
        store?.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }

    default:
      fail(`未知命令 "${args.command}"，运行 puny help 查看用法`);
  }
}

main().catch((err) => {
  process.stderr.write(`致命错误: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
