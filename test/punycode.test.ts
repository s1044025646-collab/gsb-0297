import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "../src/punycode";
import { encodeText, decodeText, explainText } from "../src/service";
import { ReportStore } from "../src/db";
import { createServer } from "../src/server";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// RFC 3492 第 7 节公开已知向量 + 常见 IDN 示例
const VECTORS: [string, string][] = [
  ["bücher", "bcher-kva"],
  ["mañana", "maana-pta"],
  ["例え", "r8jz45g"],
  ["中文", "fiq228c"],
  ["ü", "tda"],
  ["\u0644\u064A\u0647\u0645\u0627\u0628\u062A\u0643\u0644\u0645\u0648\u0634\u0639\u0631\u0628\u064A\u061F",
   "egbpdaj6bu4bxfgehfvwxn"],
  ["他们为什么不说中文", "ihqwcrb4cv8a8dqg056pqjye"],
  ["\uD83D\uDE00", "e28h"],
];

test("已知向量编码", () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(encode(input).output, expected, `encode(${input})`);
  }
});

test("已知向量解码并往返", () => {
  for (const [input, encoded] of VECTORS) {
    const dec = decode(encoded);
    assert.equal(String.fromCodePoint(...dec.codePoints), input, `decode(${encoded})`);
    assert.equal(encode(input).output, encoded);
  }
});

test("补充平面字符不被拆成代理项", () => {
  const input = "a\u{1F600}b";
  const enc = encode(input);
  const dec = decode(enc.output);
  assert.deepEqual(dec.codePoints, [97, 0x1f600, 98]);
  assert.equal(String.fromCodePoint(...dec.codePoints), input);
});

test("重复非基本码点", () => {
  const input = "üüü";
  assert.equal(String.fromCodePoint(...decode(encode(input).output).codePoints), input);
});

test("交错 ASCII 与非基本码点", () => {
  const input = "a中b文c";
  const enc = encode(input);
  assert.ok(enc.output.startsWith("abc-"));
  assert.equal(String.fromCodePoint(...decode(enc.output).codePoints), input);
});

test("纯 ASCII 与空串", () => {
  // RFC 3492 规范形式：存在基本字符时编码器追加分隔符
  assert.equal(encode("Hello-World_09").output, "Hello-World_09-");
  assert.equal(encode("").output, "");
  assert.deepEqual(decode("").codePoints, []);
  assert.equal(String.fromCodePoint(...decode("Hello-World_09-").codePoints), "Hello-World_09");
});

test("手算小例：单字符 ü (U+00FC)", () => {
  // n=128, delta=0 -> m=0xFC=252, delta=(252-128)*1=124
  // k=36, bias=72, t=1: q=124>=1 -> digit(1+(123%35)=19)='t', q=floor(123/35)=3
  // k=72, t=26: q=3<26 -> digit(3)='d'；无基本段时不加分隔符 => "tda"
  const enc = encode("ü");
  assert.equal(enc.output, "tda");
  const dec = decode("tda");
  assert.equal(dec.steps.length, 1);
  assert.equal(dec.steps[0].n, 0xfc);
  assert.equal(dec.steps[0].insertPosition, 0);
});

test("手算插入位置：bücher 的插入位置为 1", () => {
  const dec = decode("bcher-kva");
  assert.equal(dec.steps.length, 1);
  assert.equal(dec.steps[0].n, 0xfc);
  assert.equal(dec.steps[0].insertPosition, 1);
  assert.equal(String.fromCodePoint(...dec.codePoints), "bücher");
});

test("孤立代理项被拒绝并带位置", () => {
  assert.throws(() => encode("a\uD800b"), /孤立的高代理项/);
  assert.throws(() => encode("\uDC00"), /孤立的低代理项/);
  const r = encodeText("x\uD800", "raw");
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, "E_LONE_SURROGATE");
  assert.equal(r.error!.position, 1);
});

test("截断整数与非法数字", () => {
  const r1 = decodeText("abc-k", "raw");
  assert.equal(r1.ok, false);
  assert.equal(r1.error!.code, "E_TRUNCATED_INT");
  const r2 = decodeText("abc-k_v", "raw");
  assert.equal(r2.ok, false);
  assert.equal(r2.error!.code, "E_INVALID_DIGIT");
  assert.equal(typeof r2.error!.position, "number");
});

test("非法输出码点（超出 Unicode 范围）", () => {
  const r = decodeText("-99999d", "raw"); // 变长整数终止但 n 远超 U+10FFFF
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, "E_CODEPOINT_RANGE");
});

test("解码得到代理区码点被拒绝", () => {
  const r = decodeText("-ib9b", "raw"); // n = U+D800
  assert.equal(r.ok, false);
  assert.equal(r.error!.code, "E_SURROGATE_CODEPOINT");
});

test("基本字符保留大小写，数字字母大小写均可解码", () => {
  assert.equal(encode("BüCher").output, "BCher-kva");
  const lower = decode("bcher-kva");
  const upper = decode("bcher-KVA");
  assert.deepEqual(upper.codePoints, lower.codePoints);
});

test("ACE 模式规则", () => {
  const enc = encodeText("bücher", "ace");
  assert.equal(enc.output, "xn--bcher-kva");
  const dec = decodeText("xn--bcher-kva", "ace");
  assert.equal(dec.restored, "bücher");
  assert.equal(decodeText("bcher-kva", "ace").error!.code, "E_ACE_PREFIX");
  assert.equal(encodeText("", "ace").error!.code, "E_ACE_EMPTY_LABEL");
  assert.equal(encodeText("", "raw").ok, true);
});

test("explain 输出码点表与步骤", () => {
  const r = explainText("mañana", "raw");
  assert.equal(r.ok, true);
  assert.equal(r.output, "maana-pta");
  assert.equal(r.restored, "mañana");
  assert.equal(r.codePoints!.length, 6);
  assert.equal(r.codePoints![2].hex, "U+00F1");
  assert.ok(r.steps!.some((s: any) => s.kind === "encode-delta"));
  assert.ok(r.steps!.some((s: any) => s.kind === "decode-delta" && s.insertPosition === 2));
});

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "puny-")), "test.db");
}

test("报告保存后重开可读，模式变化不覆盖旧报告", () => {
  const db = tmpDb();
  let store = new ReportStore(db);
  const id1 = store.save(encodeText("bücher", "raw"));
  const id2 = store.save(encodeText("bücher", "ace"));
  store.close();
  store = new ReportStore(db);
  const r1 = store.get(id1) as any;
  const r2 = store.get(id2) as any;
  assert.equal(r1.report.output, "bcher-kva");
  assert.equal(r2.report.output, "xn--bcher-kva");
  assert.equal(r1.mode, "raw");
  assert.equal(r2.mode, "ace");
  store.close();
});

test("API 与 CLI 结果一致，批量逐项报错", async () => {
  const db = tmpDb();
  const store = new ReportStore(db);
  const server = createServer(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const apiRes = await fetch(`http://127.0.0.1:${port}/api/encode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "bücher", mode: "raw" }),
  });
  const apiJson = (await apiRes.json()) as any;
  assert.equal(apiJson.output, "bcher-kva");

  const cliOut = execFileSync(
    process.execPath,
    [path.join(__dirname, "..", "src", "cli.js"), "encode", "bücher"],
    { cwd: path.join(__dirname, "..", "..") }
  ).toString();
  assert.ok(JSON.parse(cliOut).output === apiJson.output);

  const batchRes = await fetch(`http://127.0.0.1:${port}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "encode", inputs: ["bücher", "a\uD800", "中文"] }),
  });
  const batch = (await batchRes.json()) as any;
  assert.equal(batch.total, 3);
  assert.equal(batch.succeeded, 2);
  assert.equal(batch.failed, 1);
  assert.equal(batch.items[1].error.code, "E_LONE_SURROGATE");
  assert.equal(batch.items[1].index, 1);

  const hist = (await (await fetch(`http://127.0.0.1:${port}/api/history`)).json()) as any;
  assert.ok(hist.items.length >= 4);

  server.close();
  store.close();
});
