// 沙箱验证用假 GitHub Contents API，只在本地跑，不碰真实仓库。
//
// GET /repos/<owner>/<repo>/contents/<path>?ref=<branch>  返回 { sha }；没见过该路径返回 404（首次创建）
// PUT 同一路径                                            返回 { commit: { sha } }，并记下 sha 供后续 GET
//
// 收到的每个请求（方法、路径、查询、base64 原文）逐行落到 mock-output/pages-upload.jsonl，
// 测试脚本据此断言 PUT 次数、路径前缀与内容。
//
// MODE=conflict：首个 PUT 一律回 409（sha 过期），GET 第一次回 oldsha111、之后回 newsha222，
// 用来验证"重取 sha 再 PUT，且只重试一次"。
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = Number(process.argv[2] ?? 8788);
const MODE = process.env.MOCK_GH_MODE ?? "";
const LOG = process.env.MOCK_GH_LOG ?? "mock-output/pages-upload.jsonl";

/** 已上传文件路径 → 当前 sha */
const shas = new Map();
/** conflict 模式下已回过 oldsha 的 GET 次数（按路径） */
const gets = new Map();

function record(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n", "utf8");
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // 探活路由：不记日志，免得测试的 readiness 轮询混进请求序列断言
  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  // contents 路径后面的部分就是"仓库内文件路径"
  const filePath = url.pathname.split("/contents/")[1] ?? "";

  if (req.method === "GET") {
    let sha = shas.get(filePath);
    if (MODE === "conflict" && !sha) {
      const count = gets.get(filePath) ?? 0;
      gets.set(filePath, count + 1);
      // 首次 GET 给旧 sha，之后给"别的进程刚提交过"的新 sha
      sha = count === 0 ? "oldsha111" : "newsha222";
    }
    record({ method: "GET", path: url.pathname, ref: url.searchParams.get("ref"), known: sha !== undefined });
    if (!sha) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: filePath, sha }));
    return;
  }

  if (req.method === "PUT") {
    const body = await readBody(req);
    record({ method: "PUT", path: url.pathname, body });
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    const ok =
      (req.headers.authorization ?? "").startsWith("Bearer ") &&
      req.headers["user-agent"] === "news-digest" &&
      typeof parsed.content === "string" &&
      typeof parsed.message === "string";
    if (!ok) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Bad credentials or request" }));
      return;
    }
    // 只在每个路径的第一次 PUT 回 409，之后的 PUT 正常成功
    let putCount = (gets.get(`put:${filePath}`) ?? 0) + 1;
    gets.set(`put:${filePath}`, putCount);
    if (MODE === "conflict" && putCount === 1) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Conflict. the SHA of HEAD does not match the sha you specified" }));
      return;
    }
    const sha = `commit${filePath.length.toString(16)}`;
    shas.set(filePath, sha);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: { path: filePath, sha }, commit: { sha } }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Not Found" }));
});

server.on("error", (error) => {
  console.error(`mock-github 起不来：${error.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-github listening on ${PORT} (mode=${MODE || "normal"}, log=${LOG})`);
});
