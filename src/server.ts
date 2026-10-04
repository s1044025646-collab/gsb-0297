import http from "node:http";
import net from "node:net";
import { encodeText, decodeText, explainText, parseMode } from "./service";
import { ReportStore } from "./db";
import { PunyError } from "./errors";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new PunyError("E_INVALID_REQUEST", "请求体不是合法 JSON");
  }
}

export function createServer(store: ReportStore) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && p === "/api/health") {
        return send(res, 200, { ok: true, rulesVersion: "rfc3492-bootstring-v1" });
      }

      if (method === "POST" && ["/api/encode", "/api/decode", "/api/explain"].includes(p)) {
        const body = await readBody(req);
        if (typeof body.input !== "string") {
          throw new PunyError("E_INVALID_REQUEST", "缺少字符串字段 input");
        }
        const mode = parseMode(body.mode);
        const fn = p === "/api/encode" ? encodeText : p === "/api/decode" ? decodeText : explainText;
        const report = fn(body.input, mode);
        const id = store.save(report);
        return send(res, report.ok ? 200 : 422, { id, ...report });
      }

      if (method === "POST" && p === "/api/batch") {
        const body = await readBody(req);
        const op = body.op === "decode" ? decodeText : body.op === "encode" ? encodeText : null;
        if (!op) throw new PunyError("E_INVALID_REQUEST", "batch 需要 op: 'encode' | 'decode'");
        if (!Array.isArray(body.inputs)) {
          throw new PunyError("E_INVALID_REQUEST", "batch 需要 inputs 字符串数组");
        }
        const mode = parseMode(body.mode);
        const items = body.inputs.map((input: unknown, index: number) => {
          if (typeof input !== "string") {
            const report = {
              ok: false,
              op: body.op,
              mode,
              rulesVersion: "rfc3492-bootstring-v1",
              input: String(input),
              error: { code: "E_INVALID_REQUEST", message: "条目不是字符串", position: null },
            };
            const id = store.save(report as any);
            return { index, id, ...(report as object) };
          }
          const report = op(input, mode);
          const id = store.save(report);
          return { index, id, ...report };
        });
        const failed = items.filter((i: any) => !i.ok).length;
        return send(res, 200, {
          total: items.length,
          succeeded: items.length - failed,
          failed,
          items,
        });
      }

      if (method === "GET" && p === "/api/history") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
        const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
        return send(res, 200, { items: store.list(limit, offset) });
      }

      const histMatch = p.match(/^\/api\/history\/(\d+)$/);
      if (method === "GET" && histMatch) {
        const row = store.get(Number(histMatch[1]));
        if (!row) throw new PunyError("E_NOT_FOUND", `不存在 id=${histMatch[1]} 的报告`);
        return send(res, 200, row);
      }

      if (method === "GET" && p === "/api/export") {
        return send(res, 200, { exportedAt: new Date().toISOString(), items: store.list(500, 0) });
      }

      throw new PunyError("E_NOT_FOUND", `未知路由 ${method} ${p}`);
    } catch (err) {
      if (err instanceof PunyError) {
        const status = err.code === "E_NOT_FOUND" ? 404 : 400;
        return send(res, status, { ok: false, error: err.toJSON() });
      }
      return send(res, 500, { ok: false, error: { code: "E_INTERNAL", message: String(err) } });
    }
  });
}

export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(findFreePort(preferred + 1)));
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

export async function startServer(portArg?: number): Promise<{ port: number; close: () => void }> {
  const store = new ReportStore();
  const server = createServer(store);
  const port = portArg ?? (await findFreePort(Number(process.env.PORT ?? 8787)));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    close: () => {
      server.close();
      store.close();
    },
  };
}

if (require.main === module) {
  const idx = process.argv.indexOf("--port");
  const portArg = idx >= 0 ? Number(process.argv[idx + 1]) : undefined;
  startServer(portArg).then(({ port }) => {
    console.log(`punycode 服务已启动: http://127.0.0.1:${port}`);
  });
}
