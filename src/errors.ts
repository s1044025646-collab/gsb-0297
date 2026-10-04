/**
 * 统一错误码与带位置的错误类型。
 * 所有错误都是可预期的校验/算法错误，不会退化成“看似成功”的字符串。
 */
export type ErrorCode =
  | 'EMPTY_ACE_LABEL'
  | 'ACE_PREFIX_MISSING'
  | 'INVALID_ASCII'
  | 'LONE_SURROGATE'
  | 'INPUT_TOO_LONG'
  | 'OUTPUT_TOO_LONG'
  | 'OVERFLOW'
  | 'INVALID_DIGIT'
  | 'CODEPOINT_OUT_OF_RANGE'
  | 'SURROGATE_CODEPOINT'
  | 'VARINT_TOO_LONG'
  | 'BAD_DELIMITER'
  | 'INVALID_ARGUMENT';

export class PunyError extends Error {
  readonly code: ErrorCode;
  /** 0 基字符位置（按 Unicode 码点计）；无法定位时为 -1。 */
  readonly position: number;
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, position = -1, detail?: string) {
    super(message);
    this.name = 'PunyError';
    this.code = code;
    this.position = position;
    this.detail = detail;
  }

  toJSON(): { code: ErrorCode; message: string; position: number; detail?: string } {
    return { code: this.code, message: this.message, position: this.position, detail: this.detail };
  }
}
