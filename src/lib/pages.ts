import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, PagesTarget } from "./config.ts";

/** 上传清单写死：不 readdir(outputDir)，debug 产物永远不出机器 */
const PUBLISH_FILES = ["feed.xml", "digest.md"] as const;

export interface PublishResult {
  file: string;
  commitSha: string;
  created: boolean;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub 缺 UA 会 403
    "User-Agent": "news-digest",
  };
}

function contentsUrl(pages: PagesTarget, name: string): string {
  return `${pages.apiBase}/repos/${pages.repo}/contents/${pages.dir}/${name}?ref=${encodeURIComponent(pages.branch)}`;
}

/** 非 2xx 时把响应体里的 message 带进错误信息 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // 响应体不是 JSON 就用状态码
  }
  return `HTTP ${res.status}`;
}

/** GET 现有文件的 sha；404 表示首次创建 */
async function fetchSha(pages: PagesTarget, name: string): Promise<string | undefined> {
  const res = await fetch(contentsUrl(pages, name), { headers: headers(pages.token) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${name}：GET sha 失败（${await errorMessage(res)}）`);
  const body = (await res.json()) as { sha?: string };
  if (!body.sha) throw new Error(`${name}：响应里没有 sha`);
  return body.sha;
}

async function putFile(pages: PagesTarget, outputDir: string, name: string): Promise<PublishResult> {
  const content = fs.readFileSync(path.join(outputDir, name));
  let sha = await fetchSha(pages, name);

  const send = async (): Promise<Response> =>
    fetch(contentsUrl(pages, name), {
      method: "PUT",
      headers: { ...headers(pages.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `news-digest ${new Date().toISOString()}`,
        content: content.toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });

  let res = await send();
  if (res.status === 409) {
    // sha 过期（或首次创建时路径刚被别人建出来）：重新 GET 再 PUT，只重试这一次
    sha = await fetchSha(pages, name);
    res = await send();
  }
  if (!res.ok) throw new Error(`${name}：PUT 失败（${await errorMessage(res)}）`);

  const body = (await res.json()) as { commit?: { sha?: string } };
  return { file: name, commitSha: body.commit?.sha ?? "", created: res.status === 201 };
}

export async function publishFiles(
  outputDir: string,
  files: readonly string[],
  pages: PagesTarget,
): Promise<PublishResult[]> {
  const results: PublishResult[] = [];
  // 串行发：Contents API 同一分支并发 PUT 容易撞 409
  for (const name of files) {
    const result = await putFile(pages, outputDir, name);
    results.push(result);
    console.log(`[pages] ${name} → ${result.created ? "已创建" : "已更新"} commit ${result.commitSha.slice(0, 7)}`);
  }
  return results;
}

/** 流水线末尾的唯一调用点：没配 Pages 打一行跳过，发布失败只记日志不带走定时器 */
export async function publishOutput(config: Config, projectRoot: string): Promise<void> {
  const pages = config.pages;
  if (!pages) {
    console.log("[pages] 未配置 Pages，跳过");
    return;
  }
  const outputDir = path.resolve(projectRoot, config.settings.outputDir);
  try {
    await publishFiles(outputDir, PUBLISH_FILES, pages);
  } catch (error) {
    console.error(`[pages] 发布失败：${error instanceof Error ? error.message : error}`);
  }
}
