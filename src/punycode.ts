// RFC 3492 Bootstring 核心实现（参数：base=36, tmin=1, tmax=26,
// skew=38, damp=700, initial_bias=72, initial_n=128，分隔符 '-'）。
// 不调用 Node 内置 punycode / URL 域名转换或任何第三方编解码库。

import { PunyError } from "./errors";

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = "-";

export const MAX_CODEPOINTS = 1024; // 输入标量数量上限
export const MAX_INT = Number.MAX_SAFE_INTEGER; // 数值预算
const MAX_VARINT_DIGITS = 64; // 单个变长整数的最大数字数
const MAX_CP = 0x10ffff;

export interface EncodeStep {
  kind: "encode-delta";
  codePoint: number;
  char: string;
  delta: number;
  bias: number;
  output: string;
}

export interface DecodeStep {
  kind: "decode-delta";
  index: number;
  delta: number;
  n: number;
  char: string;
  insertPosition: number;
  bias: number;
  output: string;
}

export interface EncodeResult {
  output: string;
  basicCopied: string;
  steps: EncodeStep[];
}

export interface DecodeResult {
  codePoints: number[];
  steps: DecodeStep[];
}

function digitToBasic(digit: number): string {
  // 0..25 -> a..z, 26..35 -> 0..9（编码输出固定小写）
  return String.fromCharCode(digit + (digit < 26 ? 97 : 22));
}

function basicToDigit(code: number): number {
  // 解码接受大小写字母与数字；不做额外大小写语义映射
  if (code >= 48 && code < 58) return code - 22; // 0-9
  if (code >= 65 && code < 91) return code - 65; // A-Z
  if (code >= 97 && code < 123) return code - 97; // a-z
  return -1;
}

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  delta = firstTime ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > Math.floor(((BASE - TMIN) * TMAX) / 2)) {
    delta = Math.floor(delta / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

function toCodePoints(input: string): number[] {
  const cps: number[] = [];
  let i = 0;
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    cps.push(cp);
    i++;
  }
  return cps;
}

export function validateInput(input: string): number[] {
  // 以码点为单位迭代；for..of 会把孤立代理项暴露为 U+FFFD 之前的原始值，
  // 因此这里手动扫描以精确拒绝孤立代理项并报告位置。
  const cps: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const cu = input.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (i + 1 >= input.length || next < 0xdc00 || next > 0xdfff) {
        throw new PunyError("E_LONE_SURROGATE", `位置 ${i} 处存在孤立的高代理项`, i);
      }
      cps.push((cu - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000);
      i++;
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      throw new PunyError("E_LONE_SURROGATE", `位置 ${i} 处存在孤立的低代理项`, i);
    } else {
      cps.push(cu);
    }
  }
  if (cps.length > MAX_CODEPOINTS) {
    throw new PunyError(
      "E_TOO_MANY_CODEPOINTS",
      `输入包含 ${cps.length} 个码点，超过上限 ${MAX_CODEPOINTS}`
    );
  }
  return cps;
}

export function encodeCodePoints(cps: number[]): EncodeResult {
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  let output = "";
  const steps: EncodeStep[] = [];

  for (const cp of cps) {
    if (cp < 0x80) output += String.fromCharCode(cp); // 基本字符原样复制，保留大小写
  }
  const basicCopied = output;

  const b = output.length;
  let h = b;
  if (b > 0) output += DELIMITER; // RFC 3492：存在基本字符即追加分隔符

  while (h < cps.length) {
    let m = MAX_INT;
    for (const cp of cps) {
      if (cp >= n && cp < m) m = cp;
    }
    if (m - n > Math.floor((MAX_INT - delta) / (h + 1))) {
      throw new PunyError("E_OVERFLOW", "delta 累计超出数值预算");
    }
    delta += (m - n) * (h + 1);
    n = m;
    for (const cp of cps) {
      if (cp < n) {
        if (++delta > MAX_INT) throw new PunyError("E_OVERFLOW", "delta 累计超出数值预算");
      } else if (cp === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
          if (q < t) break;
          output += digitToBasic(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digitToBasic(q);
        steps.push({
          kind: "encode-delta",
          codePoint: cp,
          char: String.fromCodePoint(cp),
          delta,
          bias: adapt(delta, h + 1, h === b),
          output,
        });
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return { output, basicCopied, steps };
}

export function decodeToCodePoints(input: string): DecodeResult {
  const output: number[] = [];
  const steps: DecodeStep[] = [];

  const delimPos = input.lastIndexOf(DELIMITER);
  const pos = delimPos < 0 ? 0 : delimPos; // 无分隔符时没有基本字符段
  let index = delimPos < 0 ? 0 : delimPos + 1;
  for (let j = 0; j < pos; j++) {
    const cu = input.charCodeAt(j);
    if (cu >= 0x80) {
      throw new PunyError("E_INVALID_DIGIT", `位置 ${j} 处基本段包含非基本字符`, j);
    }
    output.push(cu);
  }

  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;

  while (index < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) {
        throw new PunyError("E_TRUNCATED_INT", `位置 ${index} 处变长整数被截断`, index);
      }
      if (k - INITIAL_BIAS > MAX_VARINT_DIGITS * BASE) {
        throw new PunyError("E_VARINT_TOO_LONG", `位置 ${index} 处变长整数过长`, index);
      }
      const digit = basicToDigit(input.charCodeAt(index));
      if (digit < 0) {
        throw new PunyError(
          "E_INVALID_DIGIT",
          `位置 ${index} 处字符 '${input[index]}' 不是合法的 punycode 数字`,
          index
        );
      }
      index++;
      if (digit > Math.floor((MAX_INT - i) / w)) {
        throw new PunyError("E_OVERFLOW", "变长整数数值超出预算", index - 1);
      }
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) {
        throw new PunyError("E_OVERFLOW", "变长整数权重超出预算", index);
      }
      w *= BASE - t;
    }
    const consumed = i - oldi;
    const outLen = output.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    if (Math.floor(i / outLen) > MAX_INT - n) {
      throw new PunyError("E_OVERFLOW", "码点累计超出数值预算");
    }
    n += Math.floor(i / outLen);
    i = i % outLen;
    if (n > MAX_CP) {
      throw new PunyError("E_CODEPOINT_RANGE", `解码得到码点 U+${n.toString(16)} 超出 Unicode 范围`, index);
    }
    if (n >= 0xd800 && n <= 0xdfff) {
      throw new PunyError("E_SURROGATE_CODEPOINT", `解码得到代理区码点 U+${n.toString(16)}`, index);
    }
    output.splice(i, 0, n);
    steps.push({
      kind: "decode-delta",
      index: i,
      delta: consumed,
      n,
      char: String.fromCodePoint(n),
      insertPosition: i,
      bias,
      output: String.fromCodePoint(...output),
    });
    i++;
  }
  return { codePoints: output, steps };
}

export function encode(input: string): EncodeResult {
  return encodeCodePoints(validateInput(input));
}

export function decode(input: string): DecodeResult {
  if (input.length === 0) return { codePoints: [], steps: [] };
  return decodeToCodePoints(input);
}
