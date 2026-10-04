import { encodeText, decodeText, explainText, parseMode } from "./service";
import { ReportStore } from "./db";
import { startServer } from "./server";

function print(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function usage(): never {
  console.error(`用法:
  node dist/src/cli.js encode  <文本> [--mode raw|ace]
  node dist/src/cli.js decode  <串>   [--mode raw|ace]
  node dist/src/cli.js explain <文本> [--mode raw|ace]
  node dist/src/cli.js batch   <encode|decode> <json数组文件|'-'> [--mode raw|ace]
  node dist/src/cli.js history [--limit N]
  node dist/src/cli.js export
  node dist/src/cli.js serve   [--port N]`);
  process.exit(2);
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new ReportStore();
  try {
    switch (cmd) {
      case "encode":
      case "decode":
      case "explain": {
        const input = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--mode");
        if (input === undefined) usage();
        const mode = parseMode(getFlag(rest, "--mode"));
        const fn = cmd === "encode" ? encodeText : cmd === "decode" ? decodeText : explainText;
        const report = fn(input, mode);
        const id = store.save(report);
        print({ id, ...report });
        process.exitCode = report.ok ? 0 : 1;
        break;
      }
      case "batch": {
        const op = rest[0];
        const src = rest[1];
        if ((op !== "encode" && op !== "decode") || !src) usage();
        const fs = await import("node:fs");
        const raw = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
        const inputs = JSON.parse(raw);
        if (!Array.isArray(inputs)) throw new Error("批量输入必须是 JSON 字符串数组");
        const mode = parseMode(getFlag(rest, "--mode"));
        const fn = op === "encode" ? encodeText : decodeText;
        const items = inputs.map((input: unknown, index: number) => {
          const report =
            typeof input === "string"
              ? fn(input, mode)
              : { ok: false, op, mode, input: String(input), error: { code: "E_INVALID_REQUEST", message: "条目不是字符串", position: null } };
          const id = store.save(report as any);
          return { index, id, ...(report as object) };
        });
        const failed = items.filter((i: any) => !i.ok).length;
        print({ total: items.length, succeeded: items.length - failed, failed, items });
        process.exitCode = failed > 0 ? 1 : 0;
        break;
      }
      case "history": {
        const limit = Number(getFlag(rest, "--limit") ?? 50);
        print({ items: store.list(limit, 0) });
        break;
      }
      case "export": {
        print({ exportedAt: new Date().toISOString(), items: store.list(500, 0) });
        break;
      }
      case "serve": {
        const portArg = getFlag(rest, "--port");
        const { port } = await startServer(portArg ? Number(portArg) : undefined);
        console.log(`punycode 服务已启动: http://127.0.0.1:${port}`);
        return; // 保持进程
      }
      default:
        usage();
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((err) => {
  console.error(err.code ? JSON.stringify(err.toJSON?.() ?? err) : String(err.message ?? err));
  process.exit(1);
});
