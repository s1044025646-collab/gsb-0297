export type ErrorCode =
  | "E_EMPTY_INPUT"
  | "E_TOO_MANY_CODEPOINTS"
  | "E_LONE_SURROGATE"
  | "E_INVALID_DIGIT"
  | "E_TRUNCATED_INT"
  | "E_VARINT_TOO_LONG"
  | "E_CODEPOINT_RANGE"
  | "E_SURROGATE_CODEPOINT"
  | "E_OVERFLOW"
  | "E_INVALID_MODE"
  | "E_ACE_PREFIX"
  | "E_ACE_EMPTY_LABEL"
  | "E_INVALID_REQUEST"
  | "E_NOT_FOUND";

export class PunyError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public position?: number
  ) {
    super(message);
    this.name = "PunyError";
  }
  toJSON() {
    return { code: this.code, message: this.message, position: this.position ?? null };
  }
}
