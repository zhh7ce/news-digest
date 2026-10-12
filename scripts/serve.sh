#!/usr/bin/env bash
# 对外提供 RSS：起一个只读的 HTTP 服务，发 output/ 里的 feed.xml 和 digest.md。
# 浏览器打开 digest.md 会当场转成 HTML 页面，curl 和 RSS 阅读器拿到的仍是原始文件。
# 服务不发 AI 请求，所以没有 .env 也能跑（那时用默认的 8080 端口）。
#
# 端口在 .env 里（SERVE_PORT、SERVE_HOST）；临时改直接在前面传变量，命令行优先于 .env：
#   SERVE_PORT=9000 ./scripts/serve.sh
set -euo pipefail

cd "$(dirname "$0")/.."

exec node --env-file-if-exists=.env src/serve.ts
