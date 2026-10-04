/**
 * 自行实现的 RFC 3492 Punycode / Bootstring 核心。
 * 不使用 Node 的 punycode 模块、URL 域名转换，也不使用任何第三方编解码库。
 *
 * 标准参数：base=36 tmin=1 tmax=26 skew=38 damp=700
 * initial_bias=72 initial_n=128，分隔符 '-'。
 *
 * 数字字母表：a-z / 0-9。编码固定输出小写；解码时数字部分大小写均接受，
 * 基本码点（分隔符之前）则原样保留大小写，不做任何大小写语义映射。
 */
import { PunyError } from './errors.js';
import { BOOTSTRING, LIMITS } from './limits.js';
import { assertScalar, fromCodePoints, hex, toCodePoints } from './unicode.js';

const { base, tmin, tmax, skew, damp, delimiter } = BOOTSTRING;
const initialBias: number = BOOTSTRING.initialBias;
const initialN: number = BOOTSTRING.initialN;

/** RFC 3492 §3.4 偏置适配。 */
export function adapt(deltaInput: number, numPoints: number, firstTime: boolean): number {
  let delta = Math.floor(deltaInput / (firstTime ? damp : 2));
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > Math.floor(((base - tmin) * tmax) / 2)) {
    delta = Math.floor(delta / (base - tmin));
    k += base;
  }
  return k + Math.floor(((base - tmin + 1) * delta) / (delta + skew));
}

function digitToChar(d: number): string {
  // 0..25 -> a..z，26..35 -> 0..9；固定小写输出。
  return String.fromCodePoint(d + (d < 26 ? 97 : 22));
}

function charToDigit(ch: number, position: number): number {
  if (ch >= 97 && ch <= 122) return ch - 97; // a-z
  if (ch >= 65 && ch <= 90) return ch - 65; // A-Z（解码接受大写数字）
  if (ch >= 48 && ch <= 57) return ch - 22; // 0-9
  throw new PunyError(
    'INVALID_DIGIT',
    `位置 ${position} 的字符 ${String.fromCodePoint(ch)} 不是合法的 base-36 数字`,
    position,
  );
}

export interface EncodeStep {
  /** 第几个非基本码点批次（从 1 开始）。 */
  batch: number;
  /** 本批次目标码点。 */
  codepoint: string;
  /** 该批次进入变长整数编码前的 delta。 */
  delta: number;
  /** 本批次使用的起始 bias。 */
  biasBefore: number;
  /** 编码后的 bias。 */
  biasAfter: number;
  /** 输出的数字字母（小写）。 */
  digits: string;
  /** 处理到该批次时的已处理码点总数 h。 */
  processed: number;
}

export interface DecodeStep {
  /** 第几个非基本码点批次（从 1 开始）。 */
  batch: number;
  /** 解出的 delta（即插入位置）。 */
  delta: number;
  /** 还原出的码点。 */
  codepoint: string;
  /** 插入位置（0 基，指向插入“之前”的下标）。 */
  insertAt: number;
  /** 插入前的码点序列。 */
  before: string;
  /** 插入后的码点序列。 */
  after: string;
  biasBefore: number;
  biasAfter: number;
}

export interface CodePointRow {
  /** 0 基码点序号。 */
  index: number;
  codepoint: string;
  /** JS UTF-16 单元跨度（补充平面为 2）。 */
  utf16Units: 1 | 2;
  basic: boolean;
}

export interface EncodeResult {
  input: string;
  codePoints: CodePointRow[];
  /** 原始 punycode 输出（不含 xn--）。 */
  punycode: string;
  basicCount: number;
  steps: EncodeStep[];
}

export interface DecodeResult {
  /** 输入的原始 ASCII 串（不含 xn--）。 */
  input: string;
  /** 还原文本。 */
  output: string;
  codePoints: CodePointRow[];
  basicCount: number;
  steps: DecodeStep[];
}

export function codePointTable(input: string): CodePointRow[] {
  const cps = toCodePoints(input);
  return cps.map((cp, index) => ({
    index,
    codepoint: hex(cp),
    utf16Units: cp > 0xffff ? 2 : 1,
    basic: cp < initialN,
  }));
}

/** 原始 Punycode 编码（RFC 3492 §6），空串返回空串。 */
export function encodeRaw(input: string): EncodeResult {
  const inputCodePoints = toCodePoints(input);
  const codePoints = codePointTable(input);
  const output: number[] = [];
  const steps: EncodeStep[] = [];

  // 基本码点原样复制，保留大小写与顺序。
  for (const cp of inputCodePoints) {
    if (cp < initialN) output.push(cp);
  }
  const basicCount = output.length;
  let basicLen = output.length;
  if (basicLen > 0) output.push(delimiter);

  let n = initialN;
  let delta = 0;
  let bias = initialBias;
  let h = basicLen;
  const b = basicLen;
  let batch = 0;

  while (h < inputCodePoints.length) {
    let m: number = LIMITS.maxNumber;
    for (const cp of inputCodePoints) {
      if (cp >= n && cp < m) m = cp;
    }

    // delta += (m - n) * (h + 1)，显式溢出检查。
    const increment = mulChecked(m - n, h + 1);
    delta = addChecked(delta, increment);
    n = m;

    for (const cp of inputCodePoints) {
      if (cp < n) {
        delta = addChecked(delta, 1);
      } else if (cp === n) {
        batch += 1;
        const biasBefore = bias;
        const digits = encodeVarint(delta, bias, output);
        steps.push({
          batch,
          codepoint: hex(cp),
          delta,
          biasBefore,
          biasAfter: bias,
          digits,
          processed: h,
        });
        // firstTime 当且仅当已处理数仍等于基本码点数（第一个扩展码点批次），
        // 同一码点重复出现时从第二批起按 /2 而非 /700 衰减。
        const firstTime = h === b;
        bias = adapt(delta, h + 1, firstTime);
        steps[steps.length - 1]!.biasAfter = bias;
        delta = 0;
        h += 1;
      }
    }
    delta = addChecked(delta, 1);
    n = addChecked(n, 1);
  }

  if (output.length > LIMITS.maxOutputBytes) {
    throw new PunyError(
      'OUTPUT_TOO_LONG',
      `编码输出 ${output.length} 字节超过上限 ${LIMITS.maxOutputBytes}`,
      output.length,
    );
  }

  return {
    input,
    codePoints,
    punycode: fromCodePoints(output),
    basicCount,
    steps,
  };
}

/** 变长整数编码（generalized variable-length integers），就地追加到 output。 */
function encodeVarint(delta: number, bias: number, output: number[]): string {
  let q = delta;
  let k = base;
  let emitted = '';
  let digitCount = 0;
  for (;;) {
    const t = threshold(k, bias);
    if (q < t) break;
    const d = t + ((q - t) % (base - t));
    output.push(d < 26 ? d + 97 : d + 22);
    emitted += digitToChar(d);
    q = Math.floor((q - t) / (base - t));
    k += base;
    digitCount += 1;
    if (digitCount > LIMITS.maxVarintDigits) {
      throw new PunyError('VARINT_TOO_LONG', `变长整数超过 ${LIMITS.maxVarintDigits} 位`, digitCount);
    }
  }
  output.push(q < 26 ? q + 97 : q + 22);
  emitted += digitToChar(q);
  return emitted;
}

function threshold(k: number, bias: number): number {
  if (k <= bias + tmin) return tmin;
  if (k >= bias + tmax) return tmax;
  return k - bias;
}

/** 原始 Punycode 解码（RFC 3492 §6），按计算出的位置插入码点。 */
export function decodeRaw(input: string): DecodeResult {
  // 输入必须全部为 ASCII；非 ASCII 字节直接拒绝（位置按字节/下标计）。
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    if (ch > 0x7e || (ch < 0x20 && ch !== 0x09)) {
      throw new PunyError('INVALID_ASCII', `位置 ${i} 不是可打印 ASCII 字符`, i);
    }
  }

  // 最后一个分隔符划分基本部分与数字部分（RFC 3492 §6.2）。
  // 基本部分本身可含字面 '-'：如 ☃-⌘ 编码为 "--dqo34k"，
  // 最后分隔符在下标 1，之前的 "-" 是基本码点，之后 "dqo34k" 是数字。
  let lastDelim = -1;
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) === delimiter) lastDelim = i;
  }

  const output: number[] = [];
  let basicCount = 0;
  if (lastDelim > 0) {
    for (let i = 0; i < lastDelim; i++) {
      const ch = input.charCodeAt(i);
      output.push(ch); // 基本码点原样保留大小写
    }
    basicCount = output.length;
  }

  const steps: DecodeStep[] = [];
  let n = initialN;
  let bias = initialBias;
  let i = 0;
  let batch = 0;

  let pos = lastDelim + 1;
  while (pos < input.length) {
    const biasBefore = bias;
    const oldi = i;
    let w = 1;
    let k = base; // RFC T(k,bias)：k = base, 2*base, ...
    let digitCount = 0;

    for (;;) {
      if (pos >= input.length) {
        throw new PunyError('VARINT_TOO_LONG', '变长整数被截断：缺少终止数字', pos);
      }
      const ch = input.charCodeAt(pos);
      const digit = charToDigit(ch, pos);
      pos += 1;
      digitCount += 1;
      if (digitCount > LIMITS.maxVarintDigits) {
        throw new PunyError('VARINT_TOO_LONG', `变长整数超过 ${LIMITS.maxVarintDigits} 位`, pos);
      }
      i = addChecked(i, mulChecked(digit, w));
      const t = threshold(k, bias);
      // RFC 3492 §3.3：digit < t 为终止位；digit >= t 继续乘权读取下一位。
      // 数值溢出由 addChecked/mulChecked 统一拦截，不靠隐式回绕。
      if (digit < t) break;
      w = mulChecked(w, base - t);
      k += base;
    }

    const outLen = output.length + 1;
    // 注意顺序：先用“累计 i”计算 n 的增量与插入位置，
    // 再把 i 取模为下一轮的起点；不能先取模。
    const quotient = Math.floor(i / outLen);
    if (quotient > LIMITS.maxNumber - n) {
      throw new PunyError('OVERFLOW', `n 累加溢出：商 ${quotient} 超过剩余数值预算`, pos);
    }
    n += quotient; // 字符游标在批与批之间单调累计
    const cp = n;
    assertScalar(cp, pos);
    if (output.length + 1 > LIMITS.maxOutputCodePoints) {
      throw new PunyError('OUTPUT_TOO_LONG', `解码码点数量超过上限 ${LIMITS.maxOutputCodePoints}`, pos);
    }
    const insertAt = i % outLen;
    const before = fromCodePoints(output);
    output.splice(insertAt, 0, cp); // 关键：按位置插入，而非追加末尾
    const after = fromCodePoints(output);
    batch += 1;
    // 偏置适配使用本轮“原始 delta”（i - oldi），数量点为插入后长度；
    // n 与插入位置用累计 i。firstTime 仅取决于是否第一个数字批次。
    const rawDelta = i - oldi;
    const biasAfter = adapt(rawDelta, outLen, batch === 1);
    steps.push({
      batch,
      delta: rawDelta,
      codepoint: hex(cp),
      insertAt,
      before,
      after,
      biasBefore,
      biasAfter,
    });
    bias = biasAfter;
    i = insertAt + 1;
  }

  return {
    input,
    output: fromCodePoints(output),
    codePoints: codePointTable(fromCodePoints(output)),
    basicCount,
    steps,
  };
}

function addChecked(a: number, b: number): number {
  if (a > LIMITS.maxNumber - b) {
    throw new PunyError('OVERFLOW', `加法溢出：${a} + ${b} 超过数值预算 ${LIMITS.maxNumber}`);
  }
  return a + b;
}

function mulChecked(a: number, b: number): number {
  if (a !== 0 && b > Math.floor(LIMITS.maxNumber / a)) {
    throw new PunyError('OVERFLOW', `乘法溢出：${a} * ${b} 超过数值预算 ${LIMITS.maxNumber}`);
  }
  return a * b;
}
