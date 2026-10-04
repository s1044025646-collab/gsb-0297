# Punycode 编解码与插入位置解释后端

离线实现 [RFC 3492](https://www.rfc-editor.org/rfc/rfc3492) 的 **Punycode / Bootstring** 算法，提供纯 JSON 的
HTTP API 与命令行（CLI）。使用 TypeScript + Node.js + SQLite，全部为本地运行，
**不依赖 Docker、WSL、付费服务或任何在线 API**，也不使用第三方编解码库。

> 本项目只实现“原始 Punycode 算法”。它**不是**完整的国际化域名（IDN）方案。

## 它做什么 / 不做什么

**做：**
- 把一段 Unicode 标量序列编码为 ASCII 的 Punycode 表示，并可解码还原。
- 自行实现 Bootstring 的**变长整数**、**偏置适配（adapt）**与**码点按位置插入**。
- 两种模式：
  - `raw`：原始 Punycode。空串、纯 ASCII 都明确支持。
  - `ace`：只负责添加或识别 `xn--` 前缀，其余仍交给 raw 算法。
- 输出码点表、编码串、还原文本，以及每次 delta 解码与插入的关键步骤（explain）。
- 成功与失败都写入 SQLite 报告；报告不可变，改变模式只会新增记录，旧报告保持当时结果。
- encode / decode / explain / 批量转换 / 历史读取 / 导出 JSON。

**不做（刻意排除）：**
- 不做 DNS 查询。
- 不做 IDNA 名称准入（lookup/registration 规则）、禁止字符、双向规则等。
- 不做 Unicode 归一化（NFC/NFKC…）。
- 不做同形异义 / 视觉混淆判断。
- 不做额外的大小写语义映射。

因此，**编码成功只代表字符串通过了原始 Bootstring 转换，不能宣称为“完整域名合法”**。
`xn--` 也仅是 ACE 前缀包装，不是合法性认证。

## 标准参数与规则

使用 RFC 3492 §5 的标准参数：

| 参数 | 值 |
| --- | --- |
| base | 36 |
| tmin | 1 |
| tmax | 26 |
| skew | 38 |
| damp | 700 |
| initial_bias | 72 |
| initial_n | 128 |
| 分隔符 | `-`（U+002D） |

规则版本号固定为 `rfc3492-v1`，随每条报告保存。

大小写规则：
- **基本码点**（分隔符之前）按原字节顺序复制，**保留原始大小写**。
- **非基本码点的数值编码**固定输出**小写**（`a-z`、`0-9`）。
- 解码时数字部分 `a-z` 与 `A-Z` **都接受**；基本部分不做大小写转换。

已知示例：

```
bücher   -> bcher-kva
mañana   -> maana-pta
3年B组   -> 3B-w52dv59i
中文     -> fiq228c
𠮷       -> 7l3i        （U+20BB7，补充平面，单个码点）
😀       -> e28h        （U+1F600）
☃-⌘     -> --dqo34k
abc      -> abc-        （纯 ASCII：保留尾随分隔符）
（空串） -> （空串），仅 raw 模式
```

ACE 模式：`bücher -> xn--bcher-kva`。

## 环境要求

- Node.js **>= 22.5**（推荐 22.12+/24/25）。SQLite 使用 Node 内置的 `node:sqlite`，
  因此**无需任何第三方数据库驱动**。
- Windows 本地 PowerShell 即可运行；同样适用于 macOS / Linux。

## 安装、构建、测试、演示

```powershell
npm install        # 仅安装 TypeScript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行 node:test 全部用例
npm run demo       # 离线演示：向量、码点表、插入位置解释
```

## 启动 HTTP API

```powershell
npm start
# 或指定端口 / 数据文件
node dist/src/cli.js serve --port 8080 --host 127.0.0.1 --db data/punycode.db
```

- 默认 `--port 0`：由操作系统分配**空闲端口**，启动日志会打印实际端口。
- 也可用环境变量 `PORT`、`PUNYCODE_DB`。
- SQLite 数据文件位于项目内的 `data/` 目录（自动创建）。

### HTTP 接口（均为 JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/health` | 健康检查与规则版本 |
| POST | `/api/encode` | 编码。body：`{"input":"...","mode":"raw"}` |
| POST | `/api/decode` | 解码。body：`{"input":"bcher-kva","mode":"raw"}` |
| POST | `/api/encode/explain` | 编码并返回码点表与逐步解释 |
| POST | `/api/decode/explain` | 解码并返回每次 delta/插入位置解释 |
| POST | `/api/encode/batch` | 批量编码：`{"items":[{"input":"..."},...]}` |
| POST | `/api/decode/batch` | 批量解码 |
| GET  | `/api/reports?limit=50&offset=0` | 历史报告（新到旧） |
| GET  | `/api/reports/:id` | 单条报告 |
| GET  | `/api/reports/export.json` | 导出最多 2000 条报告为 JSON 文件 |

状态码：`200` 成功；`422` 单条转换被算法拒绝；`207` 批量中存在失败项；
`400` 请求参数/JSON 非法；`404` 路由或报告不存在。

```powershell
# 编码
Invoke-RestMethod http://127.0.0.1:8080/api/encode -Method Post `
  -ContentType 'application/json' -Body '{"input":"bücher"}'

# ACE 模式
Invoke-RestMethod http://127.0.0.1:8080/api/encode -Method Post `
  -ContentType 'application/json' -Body '{"input":"bücher","mode":"ace"}'

# 批量（失败逐项返回，不会只给成功数量）
Invoke-RestMethod http://127.0.0.1:8080/api/encode/batch -Method Post `
  -ContentType 'application/json' `
  -Body '{"items":[{"input":"abc"},{"input":"","mode":"ace"}]}'
```

## CLI

CLI 与 HTTP API 共用同一个核心与 runner，**结果完全一致**。默认会写 SQLite，
加 `--no-store` 可关闭持久化。

```powershell
node dist/src/cli.js encode  bücher --mode ace
node dist/src/cli.js decode  xn--bcher-kva --mode ace
node dist/src/cli.js explain decode bcher-kva
node dist/src/cli.js batch   encode items.json
node dist/src/cli.js history --limit 20
node dist/src/cli.js export  data/export.json
node dist/src/cli.js serve   --port 8080
node dist/src/cli.js help
```

批量文件 `items.json` 形如：

```json
[
  { "input": "bücher" },
  { "input": "3年B组", "mode": "raw" }
]
```

批量响应中每个条目都带 `index`（0 基）与各自的 `ok/error`，**失败不跳过**，
顶层给出 `succeeded` / `failed` 计数。

## 插入位置解释（核心要点）

解码不是把码点“追加到末尾”。每批先解出 delta 与累计位置，再计算：

```
cp       = n + floor(i / (h + 1))
insertAt = i mod (h + 1)
// 把 cp 插入到当前码点序列下标 insertAt“之前”
// 再用本轮原始 delta 做 adapt，进入下一批
```

例如 `bcher-kva`：基本部分 `bcher`，唯一非基本批次
`delta=745, cp=U+00FC(ü), insertAt=1`，于是 `"bcher" -> "bücher"`。

## 输入限制与错误码

内部一律按 **Unicode 码点（标量）**迭代，补充平面字符作为**单个码点**处理，
不会被拆成两个 UTF-16 代理项。

| 错误码 | 含义 |
| --- | --- |
| `LONE_SURROGATE` | 输入含孤立高/低代理项（带位置，直接拒绝） |
| `INVALID_ASCII` | 解码输入不是可打印 ASCII |
| `INVALID_DIGIT` | 出现非 base-36 数字字符（带位置） |
| `VARINT_TOO_LONG` | 变长整数超长或被截断（数字不完整） |
| `CODEPOINT_OUT_OF_RANGE` | 解出的码点超出 `[0, 0x10FFFF]` |
| `SURROGATE_CODEPOINT` | 解出的码点落入代理区 `U+D800..U+DFFF` |
| `OVERFLOW` | delta/乘积/码点累加超出数值预算（拒绝，不回绕） |
| `INPUT_TOO_LONG` / `OUTPUT_TOO_LONG` | 超过标量数量 / 输出长度限制 |
| `ACE_PREFIX_MISSING` | ACE 解码缺少 `xn--` 前缀 |
| `EMPTY_ACE_LABEL` | ACE 模式编码空标签（空串仅 raw 支持） |
| `INVALID_ARGUMENT` | 参数非法（模式、JSON、类型等） |

默认上限（见 `src/limits.ts`，可按需调整）：
输入标量 4096、输出码点 4096、输出字节 16384、单整数 32 位、数值预算 `INT32_MAX`。
一旦运算可能超出预算即返回 `OVERFLOW`，**不会溢出成一个看似成功的字符串**。

## 项目结构

```
src/
  punycode.ts  核心 Bootstring：adapt / 变长整数 / encode / decode + 步骤
  unicode.ts   码点迭代（拒绝孤立代理项）、码点表、标量校验
  limits.ts    标准参数、数值预算、规则版本、ACE 前缀
  errors.ts    错误码与带位置的 PunyError
  service.ts   raw / ace 模式编排
  runner.ts    单次/批量执行 + 落库（批量逐项定位）
  db.ts        node:sqlite 报告存储（不可变）
  server.ts    纯 JSON HTTP API（默认空闲端口）
  cli.ts       命令行
  demo.ts      离线演示
tests/         RFC 已知向量、手算小例、错误、补充平面、存储、API 一致性
```

核心实现刻意**没有** `import 'node:punycode'`，也没有调用 `URL` 的域名转换；
可用 `rg -n "punycode|URL" src` 自查（仅出现本项目自身的命名与注释）。

## 关于测试的独立性

为防止编解码两侧共享同一个错误，测试除往返性质外，还：
- 对一组**独立公开已知结果**断言编码值（与 Python 标准 `punycode` codec、
  常见 RFC 3492 向量一致），再断言解码。
- 用手算小例核对 `adapt` 与 `bcher-kva` / `maana-pta` 的数字与插入位置。
- 覆盖重复非基本码点、ASCII 交错、纯 ASCII、空串、截断整数、非法输出码点、
  代理区码点，并验证补充平面字符没有被拆成两个代理项。
- 验证 API 与 CLI 一致、保存后重启可读、改变模式不覆盖旧报告。

## 已知限制

- 仅后端，不提供前端页面。
- `node:sqlite` 在部分 Node 版本会打印一条 experimental 警告，功能不受影响。
- 这是原始 Punycode，不是 IDNA；如需域名准入请在其上层另行处理（本项目刻意不做）。
