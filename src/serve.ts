import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.ts";

const DEFAULT_PORT = 8080;

/** 只发这两种后缀，其它一律 404：state 文件、output/debug 里那些 prompt 原文都拿不到 */
const MIME: Record<string, string> = {
  ".xml": "application/rss+xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** 订阅者记不住的短路径 */
const ALIAS: Record<string, string> = {
  "/": "/feed.xml",
  "/feed": "/feed.xml",
  "/rss": "/feed.xml",
  "/digest": "/digest.md",
};

const projectRoot = path.resolve(import.meta.dirname, "..");
const config = loadConfig(projectRoot);
const outputDir = path.resolve(projectRoot, config.settings.outputDir);
const port = Number(process.env.SERVE_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
const host = process.env.SERVE_HOST ?? "0.0.0.0";

/**
 * 只服务 outputDir 这一层的文件：取 basename 就把 ../ 和 output/debug/ 里那堆
 * prompt 原文一并堵死了，debug 永远不会被对外发出去。
 */
function resolveFile(urlPath: string): string | null {
  const raw = urlPath.split(/[?#]/)[0] ?? "/";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const name = path.basename(ALIAS[decoded] ?? decoded);
  if (!MIME[path.extname(name).toLowerCase()]) return null;
  const file = path.join(outputDir, name);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 摘要里的 [来源](链接) 是唯一需要转成标签的行内语法 */
function inline(text: string): string {
  return escapeHtml(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`);
}

/**
 * 只认 renderMarkdown 真正写得出的那几种行（#/##/### 标题、> 说明、- 列表、--- 分隔、
 * 其余按段落），所以不需要引 markdown 库。
 */
function markdownToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of md.split("\n")) {
    const text = line.trim();
    if (text === "") {
      closeList();
      continue;
    }
    if (text === "---") {
      closeList();
      out.push("<hr>");
      continue;
    }
    if (text.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(text.slice(2))}</li>`);
      continue;
    }
    closeList();
    const heading = /^#{1,3}/.test(text) ? text.match(/^(#{1,3})\s+(.*)$/)?.[1] : undefined;
    if (heading) {
      const level = heading.length;
      out.push(`<h${level}>${inline(text.slice(level + 1))}</h${level}>`);
      continue;
    }
    out.push(text.startsWith("> ") ? `<blockquote>${inline(text.slice(2))}</blockquote>` : `<p>${inline(text)}</p>`);
  }

  closeList();
  return out.join("\n");
}

const PAGE_STYLE =
  'body{max-width:44rem;margin:1.5rem auto;padding:0 1rem;font:16px/1.7 -apple-system,"Noto Sans CJK SC","PingFang SC",sans-serif;color:#1a1a1a}' +
  "h1{font-size:1.45rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #e3e3e3;padding-bottom:.25rem}" +
  "h3{font-size:1.05rem;margin:1.5rem 0 .4rem}a{color:#0b62a4;text-decoration:none}a:hover{text-decoration:underline}" +
  "blockquote{margin:.4rem 0;padding:.4rem .8rem;border-left:3px solid #d5d5d5;color:#555;font-size:.9rem}" +
  "ul{padding-left:1.2rem;font-size:.9rem;color:#444}hr{border:0;border-top:1px solid #eee;margin:1.6rem 0}";

/** 浏览器请求 .md 时才走这里；curl 和 RSS 阅读器仍然拿到原始 MD */
function markdownPage(md: string, fallbackTitle: string): string {
  return [
    "<!doctype html>",
    '<html lang="zh-cn">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(md.match(/^#\s+(.+)$/m)?.[1] ?? fallbackTitle)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    markdownToHtml(md),
    "</body>",
    "</html>",
  ].join("\n");
}

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("只支持 GET\n");
    return;
  }

  const file = resolveFile(req.url ?? "/");
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("没有这个文件\n");
    return;
  }

  const raw = fs.readFileSync(file);
  const asPage = file.endsWith(".md") && (req.headers.accept ?? "").includes("text/html");
  const body = asPage ? Buffer.from(markdownPage(raw.toString("utf8"), path.basename(file)), "utf8") : raw;
  console.log(
    `[serve] ${req.method} ${req.url} → ${path.basename(file)} ${asPage ? "转成 HTML" : "原样"} (${body.length} 字节)`,
  );
  res.writeHead(200, {
    "Content-Type": asPage ? "text/html; charset=utf-8" : MIME[path.extname(file).toLowerCase()],
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** 起只读 HTTP 服务；被 main.ts 组合调用，也可直接 node src/serve.ts 单独跑 */
export function startServe(): http.Server {
  const server = http.createServer(requestHandler);
  server.listen(port, host, () => {
    console.log(`[serve] 目录 ${outputDir}`);
    console.log(`[serve] feed.xml / digest.md 始终是最新一份，带分钟的只是留档`);
    console.log(`[serve] 浏览器打开 digest.md 会当场转成 HTML，curl 和阅读器拿到的是原始 MD`);
    if (host === "0.0.0.0") {
      for (const address of lanAddresses()) {
        console.log(`[serve] 订阅地址 http://${address}:${port}/feed.xml`);
      }
    } else {
      console.log(`[serve] 订阅地址 http://${host}:${port}/feed.xml`);
    }
  });
  return server;
}

// 直接 node src/serve.ts 时才自启；被 main.ts import 时只导出函数、不抢跑
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) startServe();
