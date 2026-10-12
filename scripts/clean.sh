#!/usr/bin/env bash
# 清掉 AI 缓存（逐条标注结果 + 归并好的事件），让下一轮把所有条目当新的重新标注、重新归并。
# 只动 state/，不删 output/ 里已经生成的 feed。
set -euo pipefail

cd "$(dirname "$0")/.."

shopt -s nullglob
files=(state/digest-state.json state/links.json state/links.json.bak)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "state/ 里没有缓存文件，无需清理"
  exit 0
fi

for f in "${files[@]}"; do
  rm -f "$f"
  echo "已删除 $f"
done

echo "下一轮 ./scripts/update.sh 会重新逐条标注、重新归并、重新打分"
