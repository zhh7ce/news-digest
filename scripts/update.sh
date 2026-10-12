#!/usr/bin/env bash
# 跑一轮流水线：抓取 -> 逐条 AI 标注（增量）-> AI 归并 -> 逐事件打分
#   -> 写 output/：feed-<分钟>.xml + feed.xml + digest-<分钟>.md + digest.md（后两个永远是最新一份）
# 想让手机订阅：再单独跑 ./scripts/serve.sh 起 HTTP 服务
#
# 所有可调参数都在项目根的 .env（标准 KEY=VALUE 写法）。临时改单个值不用编辑文件，直接在前面传变量，
# 命令行里的环境变量优先于 .env：
#   LLM_ANNOTATE=1 ./scripts/update.sh --dump
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env && -z "${LLM_API_KEY:-}" ]]; then
  echo "错误：项目根目录没有 .env，命令行里也没有 LLM_API_KEY。先 cp .env.example .env 再填 key。" >&2
  exit 1
fi

# 没有 key 时流水线会退化成"直接输出原始列表"并覆盖 output/feed.xml，所以在这里拦住
env_key=$(sed -n 's/^[[:space:]]*LLM_API_KEY=//p' .env 2>/dev/null | tr -d '[:space:]')
if [[ -z "${LLM_API_KEY:-}" && ( -z "$env_key" || "$env_key" == "这里填你的APIKEY" ) ]]; then
  echo "错误：LLM_API_KEY 还是空的或 .env.example 里的占位值，编辑 .env 填上你的 key。" >&2
  exit 1
fi

# `--dump` 把原始抓取和每一次 AI 调用的 prompt/响应写到 output/debug/，
# 同时在 stdout 多打 [debug] 行：每个 AI 请求/每批归并的进度（第几批、共几批、结果如何）。
node --env-file-if-exists=.env src/digest.ts "$@"

echo "== 完成 =="
ls -l output/
