import { PunyError } from './errors.js';
import { LIMITS } from './limits.js';

/**
 * 以 Unicode 码点（标量）为单位迭代 JS 字符串。
 * 遇到孤立高/低代理项立即拒绝并给出其位置，绝不把它当作两个“字符”静默处理。
 * 这样补充平面字符（U+10000 以上）作为单个码点返回，而不是被拆成代理对。
 */
export function toCodePoints(input: string): number[] {
  if (typeof input !== 'string') {
    throw new PunyError('INVALID_ARGUMENT', '输入必须是字符串');
  }
  const cps: number[] = [];
  const length = input.length;
  for (let i = 0; i < length; ) {
    const cu = input.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = i + 1 < length ? input.charCodeAt(i + 1) : NaN;
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new PunyError(
          'LONE_SURROGATE',
          `位置 ${i} 出现孤立高代理项 U+${cu.toString(16).toUpperCase().padStart(4, '0')}`,
          i,
        );
      }
      const cp = 0x10000 + ((cu - 0xd800) << 10) + (next - 0xdc00);
      cps.push(cp);
      i += 2;
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      throw new PunyError(
        'LONE_SURROGATE',
        `位置 ${i} 出现孤立低代理项 U+${cu.toString(16).toUpperCase().padStart(4, '0')}`,
        i,
      );
    } else {
      cps.push(cu);
      i += 1;
    }
  }
  if (cps.length > LIMITS.maxScalars) {
    throw new PunyError(
      'INPUT_TOO_LONG',
      `输入标量数量 ${cps.length} 超过上限 ${LIMITS.maxScalars}`,
      cps.length,
    );
  }
  return cps;
}

/** 码点序列转回 JS 字符串（补充平面走合法代理对）。 */
export function fromCodePoints(cps: readonly number[]): string {
  let out = '';
  for (const cp of cps) {
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** 校验解码得到的码点必须是合法 Unicode 标量值（拒绝代理区与越界值）。 */
export function assertScalar(cp: number, position: number): void {
  if (!Number.isSafeInteger(cp) || cp < 0 || cp > 0x10ffff) {
    throw new PunyError(
      'CODEPOINT_OUT_OF_RANGE',
      `码点 ${cp} 超出 Unicode 范围 [0, 0x10FFFF]`,
      position,
    );
  }
  if (cp >= 0xd800 && cp <= 0xdfff) {
    throw new PunyError('SURROGATE_CODEPOINT', `码点 U+${cp.toString(16).toUpperCase()} 位于代理区`, position);
  }
}

export function hex(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}
