/**
 * 服务编排：raw 模式仅做原始 Punycode；ace 模式只负责添加/识别 xn-- 前缀。
 * 不执行 DNS、IDNA 准入、Unicode 归一化或视觉混淆判断；
 * 编码成功不代表完整域名合法。
 */
import { PunyError } from './errors.js';
import { ACE_PREFIX } from './limits.js';
import { decodeRaw, encodeRaw } from './punycode.js';

export type Mode = 'raw' | 'ace';

export interface TransformOptions {
  mode?: Mode;
}

export interface TransformReport {
  mode: Mode;
  direction: 'encode' | 'decode';
  input: string;
  /** 解码时为编码输入；编码时为编码输出（ace 下含 xn--）。 */
  punycode?: string;
  /** 编码时为原输入；解码时为还原文本。 */
  text?: string;
  codePoints?: unknown;
  steps?: unknown;
}

function normalizeMode(mode: string | undefined): Mode {
  if (mode === undefined || mode === 'raw') return 'raw';
  if (mode === 'ace') return 'ace';
  throw new PunyError('INVALID_ARGUMENT', `未知模式 "${mode}"，只支持 raw | ace`);
}

export function encode(input: string, options: TransformOptions = {}) {
  const mode = normalizeMode(options.mode);
  if (mode === 'ace' && input.length === 0) {
    // ACE 空标签没有意义：xn-- 单独存在不是合法标签。
    throw new PunyError('EMPTY_ACE_LABEL', 'ACE 模式拒绝空标签编码（空串仅在 raw 模式下支持）');
  }
  const result = encodeRaw(input);
  if (mode === 'ace') {
    return { ...result, mode, punycode: ACE_PREFIX + result.punycode, aceLabel: ACE_PREFIX + result.punycode };
  }
  return { ...result, mode };
}

export function decode(input: string, options: TransformOptions = {}) {
  const mode = normalizeMode(options.mode);
  let raw = input;
  if (mode === 'ace') {
    if (!input.toLowerCase().startsWith(ACE_PREFIX)) {
      throw new PunyError(
        'ACE_PREFIX_MISSING',
        `ACE 模式要求输入以 ${ACE_PREFIX} 开头（解码器严格识别前缀，不猜测）`,
        0,
      );
    }
    raw = input.slice(ACE_PREFIX.length);
    if (raw.length === 0) {
      throw new PunyError('EMPTY_ACE_LABEL', 'ACE 标签缺少前缀之后的 Punycode 内容');
    }
  }
  const result = decodeRaw(raw);
  return { ...result, mode };
}
