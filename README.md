# news-digest

多源 RSS 聚合流水线：抓取订阅源 → 逐条 AI 标注 → AI 归并成事件 → 逐事件 AI 打分 → 程序排序截断，
输出 RSS 2.0 feed 和 Markdown 摘要，可通过 GitHub Contents API 发布到 GitHub Pages。

排序、每类截断、代表条目选取、独立来源数统计都是代码里的确定性规则，AI 只做归类、合并和重要度打分。

## 环境要求

- Node.js >= 24.12（直接运行 `.ts`，不编译、不打包）
- 依赖只有 `rss-parser` 和 `yaml`
- 一个 OpenAI 兼容的对话接口（智谱 / DeepSeek 等）

## 快速开始

```sh
cp .env.example .env    # 填 LLM_API_KEY，其余照默认即可
npm install
./scripts/update.sh     # 跑一轮流水线，产物写进 output/
./scripts/serve.sh      # 起只读 HTTP 服务，订阅 http://<本机IP>:8080/feed.xml
```

不想自己起服务、想让订阅地址固定在一个公网 https 地址上，就在 `.env` 里配 `PAGES_*` 和 `FEED_URL`，
流水线末尾会把产物推到 GitHub Pages（见下面「发布到 GitHub Pages」）。

`.env` 里没有可用的 `LLM_API_KEY` 时 `scripts/update.sh` 会拒绝启动：缺 key 的流水线会退化成
「按源顺序直出原始列表」并覆盖 `output/feed.xml`。

## 流水线

一轮运行依次做这些事，`--dump`（或 `DIGEST_DUMP=1`）把每一步的输入输出落到 `output/debug/`：

1. 抓取：按 `sources/sources.yaml` 的声明顺序并发拉全部订阅源，每源最多 `maxItemsPerFeed` 条，
   不按发布时间过滤，清掉摘要里的页面垃圾，再按链接去重。
2. 逐条标注：每条新闻一次请求，要中文标题和类别。结果缓存在 `state/digest-state.json` 的 `items` 里，
   标题没变就不再请求；被内容风控拦下的那一条用原标题和该源声明的 `category` 兜底，不影响其它条目。
   `LLM_ANNOTATE=0` 整趟跳过。
3. 归并：先按类别把新条目对已有事件（锚点）做指派，再对本轮新建的事件跨类别做一趟二次归并。
   模型只回编号，链接映射留在代码里；返回不合法就退回「自成一组」，不重问。
4. 打分：每个没打过分的未事件一次请求，0-10 分，结果进缓存。`LLM_SCORE=0` 整趟跳过，所有事件记 0 分。
5. 排序截断：`SORT_BY=sources` 时按独立来源数 → 分数 → 事件内最新报道时间；`score` 时前两级互换。
   每个类别最多 `maxItemsPerCategory` 条，`MIN_SCORE` / `MIN_SOURCES` 达标的事件必留且不占名额。
6. 写 `output/`，末尾尝试发布到 Pages。

事件的板块由事件内各条报道的 AI 类别投票决定，平票时跟随代表条目；代表条目取源优先级最高、
同优先级里最新发布的那一条。

## 输出文件

| 文件 | 内容 |
| --- | --- |
| `output/feed.xml` | 永远是最新一份的合并 feed，所有板块 |
| `output/feed-<板块 id>.xml` | 每个板块一份（`feed-world.xml`、`feed-china.xml`、`feed-tech.xml`、`feed-hot.xml`、`feed-other.xml`），本轮没有事件的板块写空 feed |
| `output/digest.md` | 最新一份的 Markdown 摘要，所有板块合在一份里 |
| `output/feed-<YYYY-MM-DD-HHMM>.xml`、`output/digest-<同样标签>.md` | 每轮留档，本地时间命名 |
| `output/debug/` | `--dump` 时的原始抓取和每次 AI 调用的 prompt/响应，不会对外发布 |

板块文件名由 `feeds.yaml` 的 `categories` 里的 `id` 决定；每个板块 feed 的自址、`<atom:link rel="self">`
和 guid 前缀都指向自己的文件，所以订阅合并 feed 和订阅板块 feed 是两份独立的已读记录。

## 配置

三份文件，职责不重叠：

- `feeds.yaml`：运行参数 `settings`、类别表 `categories`、读者偏好 `profile`、三段 AI 提示词 `prompts`。
- `sources/sources.yaml`：订阅源清单。声明顺序即源优先级，调整行序就改变代表条目选取和事件内成员排序。
  `category` 只在 AI 没给出归类时兜底。
- `.env`：所有运行时开关和密钥。同名变量命令行优先于文件。

`LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_CONCURRENCY` / `LLM_RETRIES` / `LLM_RPM` /
`LLM_THINKING` / `LLM_ANNOTATE` / `LLM_SCORE` / `SORT_BY` / `MIN_SCORE` / `MIN_SOURCES` / `DIGEST_DUMP`
在 `.env` 里的值覆盖 `feeds.yaml` 的对应默认值。另有：

| 变量 | 作用 |
| --- | --- |
| `FEEDS_CONFIG` | 指向另一份 feeds.yaml（沙箱测试用） |
| `SERVE_PORT` / `SERVE_HOST` | 只被 `src/serve.ts` 用 |
| `SCHEDULE_TIME` / `TZ` | 只被 `src/schedule.ts` 的容器定时模式用，`TZ` 不带就是 UTC |
| `http_proxy` / `https_proxy` / `NODE_USE_ENV_PROXY` / `no_proxy` | 抓国外源用的代理 |
| `FEED_URL` | feed 对外的固定地址，写进 `<link>` / `<atom:link>` / guid；必须是 http 或 https |
| `PAGES_REPO` / `PAGES_BRANCH` / `PAGES_DIR` / `PAGES_TOKEN` / `PAGES_API_BASE` | Pages 发布目标 |

`FEED_URL` 和 `feeds.yaml` 的 `siteBaseUrl` 至少要有一个，否则启动即报错：RSS 2.0 的 channel `<link>`
是必填项，`siteBaseUrl` 只在 `FEED_URL` 为空时用来拼出 `<siteBaseUrl>/feed.xml`。
`siteBaseUrl` 另外还决定条目链接是否走 `/go/` 跳转前缀（自建 RSSHub 的转发路由），留空则直发原链接。

## 发布到 GitHub Pages

`.env` 里 `PAGES_REPO`（`owner/repo`）、`PAGES_DIR`（仓库内目录，不带首尾 `/`）、`PAGES_TOKEN`
三者齐全才会发布，缺任何一个只在日志打一行「未配置 Pages，跳过」。
令牌用 fine-grained PAT：Repository access 只勾目标仓库，Permissions 只给 Contents: Read and write。

上传走 GitHub Contents API：先 `GET` 取现有文件的 sha（404 表示首次创建），再 `PUT` base64 内容，
撞 `409` 时重取一次 sha 再 `PUT`。串行发送，每成功一个打一行 `[pages] feed.xml → 已更新 commit abc1234`。
上传清单是写死的规则（`feed.xml`、`digest.md` 加每个板块一份 `feed-<id>.xml`），不会 `readdir(output/)`，
`output/debug/` 里的 prompt 原文永远不出机器。发布失败只记日志、不改进程退出码。

单独补推一次（不重跑流水线）：`./scripts/publish.sh`。
想验证配置会不会真的发出去又不想动 GitHub，把 `PAGES_API_BASE` 指到一个不存在的端口，它会在 GET sha 那步失败。

## Docker

```sh
npm run docker          # 构建镜像并打印各模式的运行命令
docker compose up -d --build
```

根目录的 `docker-compose.yml` 是 `loop` 模式：容器只做定时器，每天 `SCHEDULE_TIME`（默认 02:00，
按 `TZ` 解释）自己跑一轮流水线并在末尾推到 Pages，不再对外发 HTTP。用 `network_mode: host`，
所以容器里的 `127.0.0.1:7890` 就是宿主上的代理，代价是端口由宿主直接监听。
`output/` 和 `state/` 挂在宿主机上，挂载点要能写 uid 1000（`chown -R 1000:1000 output state`）。
运行参数全部来自同目录的 `.env`（`env_file`），compose 里没有兜底默认值，改配置不用重新 build。

镜像入口脚本按第一个参数选模式：

| 模式 | 干什么 |
| --- | --- |
| `up` | 同一进程里既发 HTTP feed 又跑每天定时器 |
| `loop` | 只跑每天定时器（`docker-compose.yml` 用的就是这个） |
| `digest` | 跑一轮流水线后退出，适合放进宿主 crontab |
| `serve` | 只发 HTTP 订阅服务 |
| `publish` | 只把 `output/` 里现有的产物推上 Pages |

`examples/compose/` 下是这五种模式的参考模板，两种写法各一套：独立文件（`up.yml` 等，
拷到项目根再用，相对路径按 compose 文件自己的目录解析）和 `overlay/`（`base.yml` + 各模式的 override）。

## 本地 HTTP 服务

`src/serve.ts` 只读 `output/` 这一层的 `.xml` 和 `.md`，其它一律 404；
`path.basename` 挡住了 `../`，`output/debug/` 里的 prompt 原文拿不到。
别名 `/`、`/feed`、`/rss` → `feed.xml`，`/digest` → `digest.md`。
浏览器请求 `.md` 时当场转成 HTML 页面，`curl` 和 RSS 阅读器拿到的仍是原始文件。
板块 feed 走同一套规则，`http://<ip>:<port>/feed-tech.xml` 直接可订。

## 项目结构

```
src/digest.ts        流水线主流程与输出
src/main.ts          up 模式入口（HTTP 服务 + 定时器）
src/schedule.ts      loop 模式：每天定时起一个 digest 子进程
src/serve.ts         只读 HTTP 服务
src/publish.ts       单独补推 Pages
src/lib/config.ts    feeds.yaml / sources.yaml / .env 的读取与校验
src/lib/fetch.ts     RSS 抓取、摘要清理
src/lib/llm.ts       OpenAI 兼容接口客户端：并发、重试、每分钟限额
src/lib/merge.ts     归并的 prompt 组装与响应解析
src/lib/event.ts     事件成员、来源数、板块投票
src/lib/state.ts     state/ 里的标注与事件缓存、保留期清理
src/lib/render.ts    RSS 与 Markdown 渲染、板块 feed 的自址推导
src/lib/pages.ts     GitHub Contents API 上传
scripts/             update / serve / publish / clean / docker / docker-entrypoint
sources/sources.yaml 订阅源清单
feeds.yaml           运行参数、类别、偏好、提示词
tests/               沙箱自测：假源 + 假 LLM + 假 GitHub
docs/                待办与实现说明
```

## 检查

```sh
npm test              # 沙箱自测
npm run typecheck     # tsc --noEmit
```

`npm test` 起本地的假 LLM、假 GitHub 和假源，连跑三轮完整流程，再验证 Pages 上传清单、
base64 内容与本地文件的逐字节一致、`409` 只重试一次、缺配置不发布。
只写 `mock-output/` 和 `mock-state/`，不碰真实的 `output/` 和 `state/`，也不发任何外部请求。
