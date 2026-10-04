/**
 * 安全限制。刻意收紧，防止变长整数与 delta 累加失控。
 * delta/cp 相关运算的数值上限使用 INT32_MAX（远超 Unicode 标量空间），
 * 一旦可能超过即报 OVERFLOW，而不是依赖隐式回绕。
 */
export const LIMITS = {
  /** 输入允许的 Unicode 标量（码点）数量上限。 */
  maxScalars: 4096,
  /** 解码输出码点数量上限。 */
  maxOutputCodePoints: 4096,
  /** 编码输出 ASCII 字节数上限。 */
  maxOutputBytes: 16384,
  /** 单个变长整数允许的最大数字位数。 */
  maxVarintDigits: 32,
  /** 运算数值预算（32 位有符号最大值）。 */
  maxNumber: 0x7fffffff,
} as const;

export const RULE_VERSION = 'rfc3492-v1';
export const ACE_PREFIX = 'xn--';

/** RFC 3492 §5 标准参数。 */
export const BOOTSTRING = {
  base: 36,
  tmin: 1,
  tmax: 26,
  skew: 38,
  damp: 700,
  initialBias: 72,
  initialN: 128,
  delimiter: 0x2d, // '-'
} as const;
