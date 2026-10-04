/**
 * 可直接运行的离线演示（npm run demo）。
 * 覆盖题目指定向量 bücher / mañana，以及中文与补充平面字符。
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReportStore } from './db.js';
import { RULE_VERSION } from './limits.js';
import { codePointTable, decodeRaw, encodeRaw } from './punycode.js';
import { decode, encode } from './service.js';

const samples = ['bücher', 'mañana', '3年B组', '中文', '𠮷', '😀', '☃-⌘', 'abc', ''];

function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function main(): void {
  mkdirSync(resolve('data'), { recursive: true });
  const store = new ReportStore(resolve('data/demo.db'));

  process.stdout.write(`规则版本: ${RULE_VERSION}\n`);
  heading('编码 / 解码往返（raw 模式）');
  for (const sample of samples) {
    const enc = encodeRaw(sample);
    const dec = decodeRaw(enc.punycode);
    const roundTrip = dec.output === sample ? 'OK' : 'FAIL';
    process.stdout.write(
      `${JSON.stringify(sample)}  ->  "${enc.punycode}"  ->  ${JSON.stringify(dec.output)}  [${roundTrip}]\n`,
    );
  }

  heading('ACE 模式（仅添加/识别 xn-- 前缀）');
  for (const sample of ['bücher', 'mañana']) {
    const enc = encode(sample, { mode: 'ace' });
    const dec = decode(enc.punycode, { mode: 'ace' });
    process.stdout.write(`${JSON.stringify(sample)}  ->  ${enc.punycode}  ->  ${JSON.stringify(dec.output)}\n`);
  }

  heading('码点表：补充平面字符不拆成代理项');
  for (const row of codePointTable('😀𠮷')) {
    process.stdout.write(`#${row.index} ${row.codepoint} UTF16单元=${row.utf16Units} basic=${row.basic}\n`);
  }

  heading('解码插入位置解释（"bücher" 的编码 bcher-kva）');
  const explained = decodeRaw('bcher-kva');
  for (const step of explained.steps) {
    process.stdout.write(
      `批次${step.batch} delta=${step.delta} 码点=${step.codepoint} 插入位置=${step.insertAt} ` +
        `"${step.before}" -> "${step.after}" bias ${step.biasBefore}->${step.biasAfter}\n`,
    );
  }

  heading('编码解释（mañana 的 delta 批次）');
  for (const step of encodeRaw('mañana').steps) {
    process.stdout.write(
      `批次${step.batch} 码点=${step.codepoint} delta=${step.delta} 数字="${step.digits}" bias ${step.biasBefore}->${step.biasAfter}\n`,
    );
  }

  heading('错误也会落库（示例：ACE 模式编码空串）');
  try {
    encode('', { mode: 'ace' });
  } catch (err) {
    const id = store.save({
      direction: 'encode',
      mode: 'ace',
      input: '',
      success: false,
      result: null,
      error: { name: (err as Error).name, message: (err as Error).message },
    });
    process.stdout.write(`失败报告已保存 id=${id}: ${(err as Error).message}\n`);
  }

  store.close();
  process.stdout.write('\n演示完成。\n');
}

main();
