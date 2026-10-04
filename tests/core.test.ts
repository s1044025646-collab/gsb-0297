import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PunyError } from '../src/errors.js';
import { adapt, codePointTable, decodeRaw, encodeRaw } from '../src/punycode.js';
import { decode, encode } from '../src/service.js';

/**
 * 公开已知向量（RFC 3492 附录与各语言标准实现一致）。
 * 这些值独立于本实现，防止编解码两侧共享同一个错误。
 */
const KNOWN_VECTORS: Record<string, string> = {
  bücher: 'bcher-kva',
  mañana: 'maana-pta',
  München: 'Mnchen-3ya',
  Mañana: 'Maana-pta',
  '☃-⌘': '--dqo34k',
  '3年B组': '3B-w52dv59i',
  '😀': 'e28h',
  '𠮷': '7l3i',
  αβγ: 'mxacd',
};

describe('公开已知编码向量', () => {
  for (const [text, expected] of Object.entries(KNOWN_VECTORS)) {
    it(`encode ${JSON.stringify(text)} === ${expected}`, () => {
      assert.equal(encodeRaw(text).punycode, expected);
    });
    it(`decode ${expected} === ${JSON.stringify(text)}`, () => {
      assert.equal(decodeRaw(expected).output, text);
    });
  }
});

describe('边界输入', () => {
  it('空串 raw 编码为空、解码为空', () => {
    assert.equal(encodeRaw('').punycode, '');
    assert.equal(decodeRaw('').output, '');
  });

  it('纯 ASCII 编码得到尾随分隔符且往返一致', () => {
    // RFC 3492：存在基本码点时始终输出一个分隔符，故 "abc" -> "abc-"。
    assert.equal(encodeRaw('abc').punycode, 'abc-');
    assert.equal(decodeRaw('abc-').output, 'abc');
  });

  it('解码无分隔符串也表示基本部分为空', () => {
    assert.equal(decodeRaw('e28h').output, '😀');
  });

  it('基本 ASCII 保留大小写', () => {
    assert.equal(encodeRaw('München').punycode, 'Mnchen-3ya');
    assert.equal(decodeRaw('Mnchen-3ya').output, 'München');
  });

  it('数字部分大小写都接受（大写数字解码等价）', () => {
    // 数字部分大小写不敏感；基本码点部分（分隔符之前）仍原样保留大小写。
    assert.equal(decodeRaw('bcher-KVA').output, 'bücher');
    assert.equal(decodeRaw('bcher-KvA').output, 'bücher');
  });

  it('重复非基本码点正确往返', () => {
    const text = 'ääääöööö';
    const enc = encodeRaw(text);
    assert.equal(decodeRaw(enc.punycode).output, text);
  });

  it('ASCII 与非 ASCII 交错往返', () => {
    const text = 'a中b文c测试z';
    const enc = encodeRaw(text);
    assert.equal(decodeRaw(enc.punycode).output, text);
  });
});

describe('补充平面以单个码点处理', () => {
  it('码点表中 😀 是一个 U+1F600，UTF-16 跨度为 2', () => {
    const rows = codePointTable('😀');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.codepoint, 'U+1F600');
    assert.equal(rows[0]!.utf16Units, 2);
  });

  it('还原文本使用合法代理对，长度为 2 个 UTF-16 单元', () => {
    assert.equal(decodeRaw('e28h').output.length, 2);
  });
});

describe('拒绝孤立代理项', () => {
  it('孤立高代理项报错并给出位置', () => {
    const bad = 'a' + String.fromCharCode(0xd800) + 'b';
    assert.throws(() => encodeRaw(bad), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'LONE_SURROGATE');
      assert.equal(err.position, 1);
      return true;
    });
  });

  it('孤立低代理项报错', () => {
    const bad = 'x' + String.fromCharCode(0xdfff);
    assert.throws(() => encodeRaw(bad), /LONE_SURROGATE|孤立低代理/);
  });
});

describe('解码错误：截断整数、非法数字、越界码点', () => {
  it('截断的变长整数报 VARINT_TOO_LONG', () => {
    // "bcher-kv" 缺少最后一位数字，整数无法终止。
    assert.throws(() => decodeRaw('bcher-kv'), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'VARINT_TOO_LONG');
      return true;
    });
  });

it('非法数字字符报 INVALID_DIGIT 并给出位置', () => {
    assert.throws(() => decodeRaw('abc-!zz'), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'INVALID_DIGIT');
      assert.equal(err.position, 4);
      return true;
    });
  });

  it('解出代理区码点报 SURROGATE_CODEPOINT', () => {
    // 手工构造：基本部分为空，cp = 128 + delta。需要 delta = 0xD800-128 = 55232。
    const enc = encodeScalarForTest(0xd800);
    assert.throws(() => decodeRaw(enc), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'SURROGATE_CODEPOINT');
      return true;
    });
  });

  it('非 ASCII 解码输入报 INVALID_ASCII', () => {
    assert.throws(() => decodeRaw('bücher'), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'INVALID_ASCII');
      return true;
    });
  });
});

describe('手算小例：数字与插入位置', () => {
  it('adapt(700,1,true) 偏置', () => {
    // RFC §3.4：delta=700, numpoints=1, first：
    // 700/700=1, 1+1/1=2, k=0 => 0 + 35*2/(2+38)=70/40=1。
    assert.equal(adapt(700, 1, true), 1);
  });

  it('bcher-kva 的插入位置步骤可核对（delta=745，插到下标 1）', () => {
    const steps = decodeRaw('bcher-kva').steps;
    // ü(U+00FC) 唯一批次：delta=1, n=128+floor(1/6)=252, 插入下标 1%6=1 => "bücher"。
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.codepoint, 'U+00FC');
    assert.equal(steps[0]!.delta, 745);
    assert.equal(steps[0]!.insertAt, 1);
    assert.equal(steps[0]!.before, 'bcher');
    assert.equal(steps[0]!.after, 'bücher');
  });

  it('mañana 的 ñ 批次展示“按位置插入而非追加末尾”', () => {
    const steps = decodeRaw('maana-pta').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.codepoint, 'U+00F1');
    assert.equal(steps[0]!.insertAt, 2);
    assert.equal(steps[0]!.before, 'maana');
    assert.equal(steps[0]!.after, 'mañana');
  });

  it('真正重复的非基本码点产生多批次并逐次插入', () => {
    const enc = encodeRaw('ññ');
    assert.equal(enc.steps.length, 2);
    const dec = decodeRaw(enc.punycode);
    assert.equal(dec.steps.length, 2);
    assert.equal(dec.output, 'ññ');
  });

  it('☃-⌘ 以分隔符开头（基本部分为空）', () => {
    assert.equal(decodeRaw('--dqo34k').output, '☃-⌘');
  });
});

describe('ACE 模式边界', () => {
  it('ACE 编码添加 xn-- 前缀', () => {
    assert.equal(encode('bücher', { mode: 'ace' }).punycode, 'xn--bcher-kva');
  });

  it('ACE 解码要求前缀', () => {
    assert.throws(() => decode('bcher-kva', { mode: 'ace' }), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'ACE_PREFIX_MISSING');
      return true;
    });
  });

  it('ACE 模式拒绝空标签', () => {
    assert.throws(() => encode('', { mode: 'ace' }), (err: unknown) => {
      assert.ok(err instanceof PunyError);
      assert.equal(err.code, 'EMPTY_ACE_LABEL');
      return true;
    });
  });

  it('ACE 往返', () => {
    const label = encode('3年B组', { mode: 'ace' }).punycode;
    assert.equal(label, 'xn--3B-w52dv59i');
    assert.equal(decode(label, { mode: 'ace' }).output, '3年B组');
  });
});

describe('大量随机往返（含补充平面）', () => {
  it('100 组随机标量序列编码后解码还原', () => {
    let seed = 123456789;
    const rand = () => {
      // 确定性 LCG，避免测试依赖随机种子。
      seed = (seed * 1103515245 + 12345) % 0x80000000;
      return seed / 0x80000000;
    };
    const pools = [0x61, 0x7a, 0x100, 0x3a3, 0x4e2d, 0x6587, 0xfc, 0xf1, 0x1f600, 0x20bb7, 0x2603];
    for (let trial = 0; trial < 100; trial++) {
      const len = 1 + Math.floor(rand() * 12);
      const cps: number[] = [];
      for (let j = 0; j < len; j++) cps.push(pools[Math.floor(rand() * pools.length)]!);
      const text = String.fromCodePoint(...cps);
      const enc = encodeRaw(text).punycode;
      assert.equal(decodeRaw(enc).output, text, `往返失败: ${JSON.stringify(text)} -> ${enc}`);
    }
  });
});

/** 测试辅助：用与编码相同的变长整数规则，直接编码一个非基本码点。 */
function encodeScalarForTest(cp: number): string {
  // 复用公开 encode：构造目标字符串不可行（代理区），因此手工按 RFC 规则发数字。
  const BASE = 36;
  const TMIN = 1;
  const TMAX = 26;
  const SKEW = 38;
  const DAMP = 700;
  const INITIAL_BIAS = 72;
  const delta = cp - 128;
  let q = delta;
  let k = BASE;
  let out = '';
  const adaptLocal = (d: number, points: number, first: boolean) => {
    let dd = Math.floor(d / (first ? DAMP : 2));
    dd += Math.floor(dd / points);
    let kk = 0;
    while (dd > Math.floor(((BASE - TMIN) * TMAX) / 2)) {
      dd = Math.floor(dd / (BASE - TMIN));
      kk += BASE;
    }
    return kk + Math.floor(((BASE - TMIN + 1) * dd) / (dd + SKEW));
  };
  for (;;) {
    const t = k <= INITIAL_BIAS + TMIN ? TMIN : k >= INITIAL_BIAS + TMAX ? TMAX : k - INITIAL_BIAS;
    if (q < t) {
      out += String.fromCodePoint(q + (q < 26 ? 97 : 22));
      break;
    }
    const d = t + ((q - t) % (BASE - t));
    out += String.fromCodePoint(d + (d < 26 ? 97 : 22));
    q = Math.floor((q - t) / (BASE - t));
    k += BASE;
  }
  void adaptLocal;
  return out;
}
