# AGENTS.md

工作目录就是本仓库。语言用简体中文写注释、日志和文档；代码里的标识符用英文。

## 命令

```sh
npm install
npm run typecheck    # tsc --noEmit
npm test             # 沙箱自测，见下面「验证方式」
./scripts/update.sh  # 跑一轮真实流水线，会覆盖 output/ 和 state/
./scripts/serve.sh   # 只读 HTTP 服务
./scripts/publish.sh # 把 output/ 现有产物推上 Pages，不重跑流水线
```

## 验证方式

不要用真实流水线验证代码改动：`./scripts/update.sh` 会请求真实的新闻源和真实的 AI，
并且覆盖 `output/` 和 `state/` 里用户现有的产物。改完代码只跑

```sh
npm run typecheck && bash tests/test.sh
```

`tests/test.sh` 起本地假源、假 LLM（`tests/mock-llm.mjs`）和假 GitHub（`tests/mock-github.mjs`），
用 `tests/mock-feeds.yaml` 连跑三轮，只写 `mock-output/` 和 `mock-state/`。
要跑新的配置组合，加 `tests/` 下的假配置和假服务，别改成真实的。

几个会咬人的点：

- 残留的 mock 占着 8787 或 8788 时，新实例静默绑不上端口，请求全打在旧进程上，表现是断言莫名其妙地挂。
  `tests/test.sh` 开头会 `pkill` 并按 `/health` 探活，新的假服务必须提供不发日志的 `/health` 路由。
- 断言里 Pages 的 PUT 次数是 `2 + feeds.yaml 的类别数`，动 `categories` 要跟着改。
- 沙箱会检查 `output/debug/` 里的东西不会上台，新增上传文件时保留这条断言。

## 运行方式

Node >= 24.12 直接跑 `.ts`，不编译不打包：`node --env-file-if-exists=.env src/digest.ts`。
`tsconfig.json` 开了 `allowImportingTsExtensions` 和 `erasableSyntaxOnly`，
所以 import 要带 `.ts` 后缀，且不能写 `enum`、`namespace`、构造函数参数属性这类需要 emit 的语法。
项目只有 `rss-parser` 和 `yaml` 两个运行时依赖，别随手加库。

## 配置分层

- `feeds.yaml`：`settings`（抓取条数、并发、输出目录、feed 元信息、每类上限、排序口径、门槛、保留期）、
  `categories`、`profile`、`prompts`（item / merge / score）。
- `sources/sources.yaml`：订阅源清单，声明顺序即源优先级。
- `.env`：密钥和所有运行时开关。`src/lib/config.ts` 里 env 优先于 yaml，同名开关两边都有一份。

新增可调项时按这个规矩放：需要密钥或按部署环境变化的进 `.env`，属于内容口径的进 `feeds.yaml`，
源清单进 `sources/sources.yaml`。`docker-compose.yml` 里不要再写 `environment:` 兜底，配置只从 `.env` 经
`env_file` 注入。`.env.example` 要和 `loadConfig` 实际读的变量对得上。

## 输出契约

改这几处时要一起想清楚：

- `src/digest.ts` 的 `writeOutput` 写 `feed.xml`、`digest.md`、`feed-<分钟>.xml`、`digest-<分钟>.md`
  和每个板块一份 `feed-<category id>.xml`；板块文件按 `config.categories` 逐个写，
  本轮没有事件的板块写空 feed。文件名规则必须和 `src/lib/pages.ts` 的 `publishList` 一致，
  两边改一边会导致发布漏文件。
- `src/lib/render.ts` 里 guid 的前缀是 `meta.selfUrl`，板块 feed 的自址由 `categoryFeedMeta` 从整体
  feed 的自址换文件名得到。改 `FEED_URL`、`siteBaseUrl` 或类别 id 都会换掉全部 guid，
  订阅端会把所有条目当未读重标一次，这是可预期的副作用，不需要写迁移代码。
- 写文件统一「同目录临时文件 + `renameSync`」，为的是 `serve.ts` 永远读到完整一份，别改成直接覆盖。
- `src/lib/pages.ts` 的上传清单是写死的，不 `readdir(outputDir)`；`output/debug/` 里的 prompt 原文
  永远不该出机器。`src/serve.ts` 只发 `output/` 一层的 `.xml` 和 `.md`（`MIME` 表是唯一白名单），
  新增产物类型要同步改它。
- 发布失败只打日志、不改退出码：`loop` 模式的定时器不能因为一次上传失败就被带走。

## 外部约束

订阅端是鸿蒙上的 RSS 客户端：feed 里出现非 http/https 的链接会在刷新时报 2300003（预览页面看不出来），
所以 `FEED_URL` 只接受 http/https，`loadConfig` 在 `FEED_URL` 和 `siteBaseUrl` 都为空时直接抛错。

飞牛 NAS 的统一网关（FN Connect）会给无 cookie 的 GET 返回 HTML 登录页，不能当订阅地址；
容器用 `network_mode: host` 才能用宿主上 `127.0.0.1:7890` 的代理。

## Git

commit 只到本地，不 push，除非用户明确要求。不要把 `.env`、`news-digest.tar`（`docker save` 的镜像包，
181 MB）加进版本库。实现和文档（README、AGENTS.md、注释性改动）分开提交。
提交信息用简体中文一句话说清改动，必要时正文补一句为什么。
