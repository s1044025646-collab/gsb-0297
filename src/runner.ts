import { ReportStore } from './db.js';
import { PunyError } from './errors.js';
import { RULE_VERSION } from './limits.js';
import { decode, encode, type Mode } from './service.js';

export type Direction = 'encode' | 'decode';

export interface SingleResponse {
  ok: boolean;
  ruleVersion: string;
  mode: Mode;
  direction: Direction;
  input: string;
  result?: unknown;
  error?: ReturnType<PunyError['toJSON']>;
  reportId?: number;
}

function isPunyError(err: unknown): err is PunyError {
  return err instanceof PunyError;
}

/** 执行一次转换并落库；失败同样生成失败报告（不抛出，便于 API 统一返回）。 */
export function runTransform(
  store: ReportStore | undefined,
  direction: Direction,
  input: string,
  mode: Mode,
  includeSteps: boolean,
): SingleResponse {
  try {
    const result = direction === 'encode' ? encode(input, { mode }) : decode(input, { mode });
    const stored = includeSteps
      ? result
      : stripSteps(result);
    const reportId = store?.save({
      direction,
      mode,
      input,
      success: true,
      result: stored,
    });
    return {
      ok: true,
      ruleVersion: RULE_VERSION,
      mode,
      direction,
      input,
      result: stored,
      reportId,
    };
  } catch (err) {
    const normalized = isPunyError(err)
      ? err.toJSON()
      : { code: 'INVALID_ARGUMENT' as const, message: (err as Error).message, position: -1 };
    const reportId = store?.save({
      direction,
      mode,
      input,
      success: false,
      result: null,
      error: normalized,
    });
    return {
      ok: false,
      ruleVersion: RULE_VERSION,
      mode,
      direction,
      input,
      error: normalized,
      reportId,
    };
  }
}

function stripSteps(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const cloned = { ...(result as Record<string, unknown>) };
    delete cloned.steps;
    return cloned;
  }
  return result;
}

export interface BatchItemRequest {
  input: string;
  mode?: Mode;
}

export interface BatchItemResponse extends SingleResponse {
  /** 批量中的条目序号（0 基），用于逐项定位。 */
  index: number;
}

export function runBatch(
  store: ReportStore | undefined,
  direction: Direction,
  items: BatchItemRequest[],
  defaultMode: Mode,
  includeSteps: boolean,
): { ok: boolean; items: BatchItemResponse[]; succeeded: number; failed: number } {
  const responses = items.map((item, index) => {
    if (typeof item?.input !== 'string') {
      const error = {
        code: 'INVALID_ARGUMENT' as const,
        message: `第 ${index} 项缺少字符串类型的 input`,
        position: -1,
      };
      const reportId = store?.save({
        direction,
        mode: defaultMode,
        input: String(item?.input ?? ''),
        success: false,
        result: null,
        error,
      });
      return {
        index,
        ok: false as const,
        ruleVersion: RULE_VERSION,
        mode: defaultMode,
        direction,
        input: String(item?.input ?? ''),
        error,
        reportId,
      };
    }
    return {
      index,
      ...runTransform(store, direction, item.input, item.mode ?? defaultMode, includeSteps),
    };
  });
  const failed = responses.filter((r) => !r.ok).length;
  return {
    ok: failed === 0,
    items: responses,
    succeeded: responses.length - failed,
    failed,
  };
}
