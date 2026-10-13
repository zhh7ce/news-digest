#!/usr/bin/env bash
# 单独补发：把 output/ 里现有的 feed.xml 和 digest.md 推到 GitHub Pages，不重跑流水线。
# 正常部署不需要它——每轮流水线末尾（src/digest.ts）已经发过一次，这里只用于
# "feed 早就生成好了、现在只想补推一次"，或者验证 PAGES_* 配置对不对。
#
# 需要 .env 里 PAGES_REPO / PAGES_DIR / PAGES_TOKEN 三者齐全；缺任何一个不会报错，
# 只打一行"未配置 Pages，跳过"就退出（这是设计：缺项 = 不发布）。
# 临时改单个值直接在前面传变量，命令行里的优先于 .env：
#   PAGES_DIR=static/news-digest-test ./scripts/publish.sh
#
# 想先确认会不会真的发出去、又不想动 GitHub：把 PAGES_API_BASE 指到一个不存在的端口，
# 它会在 GET sha 那一步失败并打出 [pages] 发布失败，不会写到任何仓库。
set -euo pipefail

cd "$(dirname "$0")/.."

exec node --env-file-if-exists=.env src/publish.ts
