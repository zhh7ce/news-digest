# ToDo：把产物推到 GitHub Pages

流水线在本地 `output/` 生成 `feed.xml` 与 `digest.md`，再由一个发布步骤通过 GitHub Contents API
推到 `zhh7ce.github.io` 仓库的 `static/news-digest/`，订阅地址用 Pages 的 https。
源码仓库不改公开结构、不新建仓库，`output/debug/` 与 `state/` 永远不出机器。

## 0. 一次性手工准备（不动代码）

- 建 fine-grained PAT：Repository access 只勾 `zhh7ce.github.io`，Permissions 里给
  `Contents: Read and write`，其它一律不给。
- 在 `zhh7ce.github.io` 仓库里先手工建 `static/news-digest/` 目录（放个占位文件即可），
  免得首次 PUT 时因路径不存在而行为不确定。

## 1. `.env.example` 增加发布配置

```
# GitHub Pages 发布目标：owner/repo、分支、仓库内目录（不带首尾 /）
PAGES_REPO=zhh7ce/zhh7ce.github.io
PAGES_BRANCH=main
PAGES_DIR=static/news-digest
# Contents API 的 Contents 写权限令牌，只授权上面那一个仓库
PAGES_TOKEN=
# feed.xml 对外的固定地址，写进 channel 的 <link> 和 <atom:link>
FEED_URL=https://zhh7ce.github.io/static/news-digest/feed.xml
# 仅测试用：指向本地假 GitHub API，默认 https://api.github.com
PAGES_API_BASE=
```

## 2. `src/lib/config.ts`：读这些 env

- `Settings` 不动。`siteBaseUrl` 继续只当条目链接的 `/go/` 前缀用，语义不混。
  发布目标属于部署信息，与 `LLM_API_KEY` 同级，放 env 不放 feeds.yaml。
- `Config` 增加两个字段：

```ts
export interface PagesTarget {
  apiBase: string;
  repo: string;
  branch: string;
  dir: string;
  token: string;
}

// Config 里
pages?: PagesTarget; // PAGES_REPO / PAGES_DIR / PAGES_TOKEN 三者齐全才给，缺一个就是不发布
feedUrl?: string;
```

- 解析放在 `loadConfig` 里 `apiKey` 那一段旁边，顺手校验：`repo` 必须形如 `owner/name`，
  `dir` 去掉首尾 `/`，`apiBase` 去尾 `/`。不合法直接抛错——发到别的仓库或目录属于配置写错，
  必须立刻响，不能静默。
- 日志里 token 只报"已配置/未配置"，不打印值。
- 验收：加载 config 打印 `pages`，三种缺项组合都得到 `undefined`。

## 3. 新增 `src/lib/pages.ts`

职责只有"把给定文件 PUT 到 Contents API"。

```ts
export interface PublishResult {
  file: string;
  commitSha: string;
  created: boolean;
}

export async function publishFiles(
  outputDir: string,
  files: readonly string[],
  pages: PagesTarget,
): Promise<PublishResult[]>;
```

实现要点：

- 上传清单由调用方传入并写死成 `["feed.xml", "digest.md"]`。不要 `readdir(outputDir)`，
  否则哪天 debug 产物落错一层就跟着一起公开了。
- 每个文件两步：
  - `GET {apiBase}/repos/{repo}/contents/{dir}/{name}?ref={branch}` 取 `sha`；
    404 表示首次创建，PUT 不带 `sha`。
  - `PUT` 同一路径，请求体 `{ message: "news-digest <时间>", content: <base64>, sha? }`。
- Header：`Authorization: Bearer`、`Accept: application/vnd.github+json`、
  `X-GitHub-Api-Version: 2022-11-28`、`User-Agent: news-digest`（缺 UA 会被 GitHub 403）。
- `409` 表示 `sha` 已过期：重新 GET 一次 `sha` 再 PUT，只重试这一次，其它状态码不重试。
- 非 2xx 抛错，并把响应体里的 `message` 带进错误信息。
- 串行发，每成功一个打一行 `[pages] feed.xml → 已更新 commit abc1234`。

## 4. 去掉 `file://` 自址（2300003 的根因）

- `src/digest.ts:478` 改成自址只从合法 http(s) 来：

```ts
selfUrl: config.feedUrl ?? `${config.settings.siteBaseUrl.replace(/\/+$/, "")}/feed.xml`,
```

- 两个都没配时（`siteBaseUrl` 现在允许是空串）在 `loadConfig` 里抛错：
  `FEED_URL 与 settings.siteBaseUrl 至少要有一个——RSS 2.0 的 channel <link> 是必填项，
  写 file:// 会被鸿蒙的 http 模块以 2300003 拒掉`。
- `src/lib/render.ts:100` 的 guid 前缀不动：`meta.selfUrl` 固定成一个 https 地址后 guid 天然稳定，
  改它反而会让所有条目重新变未读。
- 副作用要认下来：自址从 `file://` 换成 https 会让 guid 变一次，订阅端这一轮全部重标未读。

## 5. 接线：什么时候发

- 在 `pages.ts` 里再包一层 `publishOutput(config)`：`config.pages` 为空就打一行
  "未配置 Pages，跳过"，否则发那两份并打进度。调用点只有一行。
- `src/digest.ts` 流水线末尾（`writeOutput` 之后）调用，手动跑一轮也能立刻发布。
- `src/schedule.ts` 每轮跑完调用；发布失败只记日志，不能让一次上传失败把每天的定时器带走。
- 新增 `src/publish.ts`：只做 `publishOutput(loadConfig(projectRoot))`，与 `digest.ts`、
  `serve.ts` 同级，用于"流水线早跑过了，现在单独补发"。

## 6. 容器侧

- `Dockerfile` 不用改，`COPY src ./src` 已覆盖新文件。
- `scripts/docker-entrypoint.sh` 加一条模式并补注释：

```sh
publish) exec node --env-file-if-exists=.env src/publish.ts ;;
```

- `docker-compose.yml` 的 env 透传里加 `PAGES_REPO` / `PAGES_BRANCH` / `PAGES_DIR` /
  `PAGES_TOKEN` / `FEED_URL`；现在是 `env_file` 就不用动 compose，只改宿主 `.env`。

## 7. `tests/test.sh` 沙箱验证，不碰真 GitHub

- 新增 `tests/mock-github.mjs`：本地 http 服务，GET 返回 404（首轮）或固定 sha，
  PUT 返回 `{commit:{sha:"deadbeef"}}`，并把收到的请求路径与 base64 原样落到
  `mock-output/pages-upload.jsonl`。
- 测试里 `PAGES_API_BASE=http://127.0.0.1:<port>`，跑一轮带 `PAGES_*` 的配置。
- 断言三件事：
  - PUT 只有两次，且路径前缀是 `static/news-digest`。
  - base64 解出来与 `mock-output` 里的文件逐字节相同。
  - 在 `output/debug/` 放一个假文件，确认它不在上传清单里。
- 再断一条 409 分支：mock 首次 GET 返回旧 sha、PUT 返 409、二次 GET 返新 sha，
  确认只重试一次就成功。

## 8. 文档（与代码分开两个 commit）

- `feeds.yaml` 里 `siteBaseUrl` 的注释补一句：自址现在优先取 `FEED_URL`，
  `siteBaseUrl` 只用于 `/go/` 前缀。
- `.env.example` 的注释本身承担主要说明。

## 9. 部署收尾（人工，两件必须确认）

- 先确认 NAS 上那个容器真的在跑流水线并覆盖挂载的 `./output`：`:2345` 现在发的是
  `lastBuildDate Mon, 12 Oct 2026 13:56:12 GMT` 的旧文件，说明这一轮从来没写进去。
  这个不解决，推到 Pages 的也是旧的。
- 推完在浏览器看一次 `https://zhh7ce.github.io/static/news-digest/feed.xml`。
  Pages 的 CDN 缓存约 10 分钟，每次 PUT 还会触发一次站点构建，构建期间旧版本继续可访问，
  所以每天一轮的更新会延迟几分钟才见得到。
- RSS 应用的订阅地址换成这个 https，`2300003` 就该消失。

## 建议顺序

1 → 2 → 3 → 4 → 7 → 5 → 6 → 8 → 9。
第 7 步的 mock 服务要在第 5 步接进流水线之前写好，否则整条链路只能靠真仓库验证。
