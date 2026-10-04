import { encode, decode, validateInput, EncodeStep, DecodeStep } from "./punycode";
import { PunyError } from "./errors";

export const RULES_VERSION = "rfc3492-bootstring-v1";
export const ACE_PREFIX = "xn--";

export type Mode = "raw" | "ace";

export interface CodePointEntry {
  index: number;
  codePoint: number;
  hex: string;
  char: string;
  isBasic: boolean;
}

export interface OpReport {
  ok: boolean;
  op: "encode" | "decode";
  mode: Mode;
  rulesVersion: string;
  input: string;
  codePoints?: CodePointEntry[];
  output?: string;
  restored?: string;
  steps?: (EncodeStep | DecodeStep)[];
  error?: { code: string; message: string; position: number | null };
}

export function parseMode(mode: unknown): Mode {
  if (mode === undefined || mode === null) return "raw";
  if (mode === "raw" || mode === "ace") return mode;
  throw new PunyError("E_INVALID_MODE", `未知模式 '${mode}'，仅支持 raw | ace`);
}

export function codePointTable(input: string): CodePointEntry[] {
  const cps = validateInput(input);
  return cps.map((cp, index) => ({
    index,
    codePoint: cp,
    hex: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
    char: String.fromCodePoint(cp),
    isBasic: cp < 0x80,
  }));
}

export function encodeText(input: string, mode: Mode): OpReport {
  const report: OpReport = {
    ok: false,
    op: "encode",
    mode,
    rulesVersion: RULES_VERSION,
    input,
  };
  try {
    if (typeof input !== "string") throw new PunyError("E_INVALID_REQUEST", "input 必须是字符串");
    if (mode === "ace" && input.length === 0) {
      throw new PunyError("E_ACE_EMPTY_LABEL", "ACE 模式下拒绝空标签");
    }
    const table = codePointTable(input);
    const result = encode(input);
    report.codePoints = table;
    report.output = mode === "ace" ? ACE_PREFIX + result.output : result.output;
    report.steps = result.steps;
    report.ok = true;
  } catch (err) {
    report.error = toErrorJson(err);
  }
  return report;
}

export function decodeText(input: string, mode: Mode): OpReport {
  const report: OpReport = {
    ok: false,
    op: "decode",
    mode,
    rulesVersion: RULES_VERSION,
    input,
  };
  try {
    if (typeof input !== "string") throw new PunyError("E_INVALID_REQUEST", "input 必须是字符串");
    let body = input;
    if (mode === "ace") {
      if (!input.toLowerCase().startsWith(ACE_PREFIX)) {
        throw new PunyError("E_ACE_PREFIX", `ACE 模式要求输入以 '${ACE_PREFIX}' 开头`);
      }
      body = input.slice(ACE_PREFIX.length);
      if (body.length === 0) {
        throw new PunyError("E_ACE_EMPTY_LABEL", "ACE 模式下拒绝空标签");
      }
    }
    const result = decode(body);
    const restored = String.fromCodePoint(...result.codePoints);
    report.restored = restored;
    report.codePoints = codePointTable(restored);
    report.steps = result.steps;
    report.ok = true;
  } catch (err) {
    report.error = toErrorJson(err);
  }
  return report;
}

export function explainText(input: string, mode: Mode): OpReport {
  // explain = 编码 + 解码 + 关键步骤合并展示
  const enc = encodeText(input, mode);
  if (!enc.ok) return { ...enc, op: "encode" };
  const rawEncoded = mode === "ace" ? enc.output!.slice(ACE_PREFIX.length) : enc.output!;
  const dec = decode(rawEncoded);
  const report: OpReport = {
    ...enc,
    restored: String.fromCodePoint(...dec.codePoints),
    steps: [...(enc.steps ?? []), ...dec.steps],
  };
  return report;
}

function toErrorJson(err: unknown): { code: string; message: string; position: number | null } {
  if (err instanceof PunyError) return err.toJSON();
  return { code: "E_INVALID_REQUEST", message: String(err), position: null };
}
