# Punycode 编解码与插入位置解释后端

离线、本地运行的 RFC 3492 Bootstring（Punycode）编解码服务。仅提供 HTTP API 与 CLI，无前端。
核心算法（变长整数、偏置适配、码点插入）为自行实现，**不调用** Node 内置 `punycode`、
`URL` 域名转换或任何第三方编解码库。运行时零依赖（SQLite 使用 Node 内置 `node:sqlite`）。

## 范围说明：原始算法 ≠ 域名处理

本项目只实现 RFC 3492 的**原始 Punycode 算法**：

- 不做 DNS 查询、不做 IDNA 名称准入（Nameprep/Stringprep）、不做 Unicode 归一化（NFC）、
  不做视觉混淆（confusable）判断；
- `ace` 模式只负责添加 / 识别 `xn--` 前缀。**编码成功不代表输出是合法域名标签**
  （长度、连字符位置、LDH 约束等均不校验）；
- 基本 ASCII 字符按原顺序、原大小写复制；非基本码点的数值编码固定输出小写；
  解码时数字字母 `a-z`/`A-Z` 均可接受（等价），不做额外大小写语义映射。

## 算法参数

`base=36, tmin=1, tmax=26, skew=38, damp=700, initial_bias=72, initial_n=128`，分隔符 `-`。
内部以 Unicode 码点为单位迭代，支持 BMP 之外字符（如 emoji），孤立代理项会被拒绝并报告位置。

限制（数值预算）：

- 输入最多 1024 个码点（`E_TOO_MANY_CODEPOINTS`）；
- 单个变长整数最多 64 位数字（`E_VARINT_TOO_LONG`）；
- 所有累计值不得超过 `Number.MAX_SAFE_INTEGER`（`E_OVERFLOW`）；
- 解码结果码点必须在 `0..U+10FFFF` 且不在代理区（`E_CODEPOINT_RANGE` / `E_SURROGATE_CODEPOINT`）。

## 模式

- `raw`（默认）：原始 Punycode。空串与纯 ASCII 明确支持
  （按 RFC 规范形式，含基本字符时编码器追加尾部 `-`，如 `Hello` → `Hello-`）。
- `ace`：编码时给 raw 输出加 `xn--` 前缀；解码时要求输入以 `xn--`（大小写不敏感）开头。
  ACE 模式下**空标签被拒绝**（`E_ACE_EMPTY_LABEL`）。

编码器输出规范形式（小写数字、按需分隔符）；解码器接受范围更宽（大小写数字均可、
可解码非规范但数值合法的输入）。二者刻意区分。

## 安装与运行（Windows 本地，Node >= 22）

```bat
npm install        :: 仅安装开发依赖 typescript / @types/node
npm run build      :: 编译到 dist/
npm test           :: 构建并运行全部测试（node:test）
npm start          :: 启动 HTTP 服务（默认自动选择空闲端口，从 8787 起探测）
npm run demo       :: 运行演示样例（bücher / mañana / 中文 / 补充平面字符）
```

指定端口：`node dist/src/cli.js serve --port 9000`，或设置环境变量 `PORT`。
数据保存在项目内 `data/punycode.db`（SQLite），重启后历史报告仍可读取；
每条报告记录当时的模式与规则版本（`rfc3492-bootstring-v1`），之后改变模式不会覆盖旧报告。

## HTTP API

所有响应均为 JSON。失败时业务错误返回 4xx/422 及 `{ ok:false, error:{ code, message, position } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与规则版本 |
| POST | `/api/encode` | `{ input, mode? }` → 码点表 + 编码串 + 编码步骤 |
| POST | `/api/decode` | `{ input, mode? }` → 还原文本 + 每次 delta 解码与插入位置 |
| POST | `/api/explain` | 编码 + 解码合并解释（含码点表与全部关键步骤） |
| POST | `/api/batch` | `{ op: "encode"\|"decode", inputs: [...], mode? }`，逐项返回，失败条目带 `index` 与错误，不会只报成功数 |
| GET | `/api/history?limit=&offset=` | 历史报告列表 |
| GET | `/api/history/:id` | 单条报告 |
| GET | `/api/export` | 导出全部报告为 JSON |

示例：

```bat
curl -X POST http://127.0.0.1:8787/api/explain -H "Content-Type: application/json" -d "{\"input\":\"bücher\"}"
```

## CLI

```bat
node dist/src/cli.js encode  bücher [--mode raw|ace]
node dist/src/cli.js decode  bcher-kva [--mode raw|ace]
node dist/src/cli.js explain mañana
node dist/src/cli.js batch   encode inputs.json   :: 或 '-' 从 stdin 读 JSON 数组
node dist/src/cli.js history [--limit 20]
node dist/src/cli.js export
node dist/src/cli.js serve [--port 8787]
```

## 错误码

`E_EMPTY_INPUT` `E_TOO_MANY_CODEPOINTS` `E_LONE_SURROGATE` `E_INVALID_DIGIT`
`E_TRUNCATED_INT` `E_VARINT_TOO_LONG` `E_CODEPOINT_RANGE` `E_SURROGATE_CODEPOINT`
`E_OVERFLOW` `E_INVALID_MODE` `E_ACE_PREFIX` `E_ACE_EMPTY_LABEL`
`E_INVALID_REQUEST` `E_NOT_FOUND`

## 演示样例

- `bücher` → `bcher-kva`（ACE：`xn--bcher-kva`）
- `mañana` → `maana-pta`
- `中文` → `fiq228c`；`他们为什么不说中文` → `ihqwcrb4cv8a8dqg056pqjye`
- `😀`（U+1F600，补充平面）→ `e28h`，按单个码点处理，不拆成代理对

## 测试

`npm test` 覆盖：RFC 3492 第 7 节公开向量、独立手算小例（`ü`→`tda` 的数字推导、
`bcher-kva` 的插入位置 1）、重复非基本码点、交错 ASCII、纯 ASCII、空串、截断整数、
非法数字、超范围码点、代理区码点、孤立代理项、补充平面不拆代理对、
API 与 CLI 一致性、SQLite 重启可读、模式变更不覆盖旧报告、批量逐项报错。

## 已知限制

- 仅原始 Bootstring，不含 IDNA/UTS-46；`xn--` 输出不等于合法域名；
- 历史报告上限导出 500 条（`/api/export`）；
- 服务仅监听 `127.0.0.1`，无认证，供本机使用。
