#!/usr/bin/env bash
# 沙箱自测：起本地假 LLM（tests/mock-llm.mjs 自带三个假源），用 tests/mock-feeds.yaml 连跑三轮完整流程。
# 只写 ./mock-output 和 ./mock-state，不碰真实的 output/ 和 state/，也不发任何外部请求。
#
# 假源里 29 条报道覆盖 23 个事件（同一事件在不同源里标题不同、链接不同）。
# 前两轮假 LLM 开着"捣乱"（MOCK_CHAOS 默认开）：
#   - 每 7 条逐条标注回一次 HTTP 400 风控 → 只有那一条用原标题兜底
#   - 归并输出里掺不存在的锚点编号、不存在的条目、重复条目，每 5 次整段返回非 JSON
#     → 全部安全退回自成一组，不重问模型
#   - 每 5 个事件打分回一次风控 → 这些事件下一轮重试
# 第二轮数据不变：标注全部命中缓存、归并零请求。
# 第三轮换干净的假 LLM（MOCK_CHAOS=0）并让假源多出 2 条新报道：只标注这 2 条，
# 其中 E1 的那条要作为新成员并进已有事件，且不能抢走代表条目（标题、链接仍是最优先源的最新那条）。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${MOCK_PORT:-8787}"

start_mock() {
  MOCK_CHAOS="$1" node tests/mock-llm.mjs "$PORT" >/dev/null 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/feeds/s1.xml" >/dev/null && return 0
    sleep 0.1
  done
  echo "假 LLM 没起来" >&2
  exit 1
}

stop_mock() {
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
}
trap stop_mock EXIT

run() {
  env -u http_proxy -u https_proxy no_proxy="127.0.0.1,localhost" \
    FEEDS_CONFIG="$1" \
    LLM_API_BASE="http://127.0.0.1:$PORT/v1" \
    LLM_API_KEY=mock LLM_MODEL=mock LLM_CONCURRENCY=4 LLM_RETRIES=0 \
    DIGEST_DUMP=1 \
    node src/digest.ts | grep -E '^\[(fetch|run|item|merge|score|state)\]'
}

rm -rf mock-output mock-state
mkdir -p mock-output
# 第三轮的源列表只把 URL 换成 /feeds/r2/...，假源里多出两条"这一轮刚出现"的报道
sed 's|/feeds/|/feeds/r2/|' tests/mock-feeds.yaml > mock-output/feeds-round3.yaml

start_mock 1

echo "== 第一轮（空缓存 + 假 LLM 捣乱）=="
run tests/mock-feeds.yaml

echo
echo "== 第二轮（同一批数据，缓存应全部命中）=="
run tests/mock-feeds.yaml

stop_mock
start_mock 0

echo
echo "== 第三轮（干净假 LLM + 假源新增 2 条报道）=="
run mock-output/feeds-round3.yaml

echo
echo "== 检查 =="
node --input-type=module -e '
import * as fs from "node:fs";
const store = JSON.parse(fs.readFileSync("mock-state/digest-state.json", "utf8"));
const filtered = Object.values(store.items).filter((i) => i.filtered).length;
const e1 = Object.values(store.events).find((e) => e.titleZh.startsWith("事件E1："));
console.log(`缓存条目 ${Object.keys(store.items).length} 条（其中被风控用原标题兜底 ${filtered} 条）、事件 ${Object.keys(store.events).length} 个`);
console.log(`E1 事件成员 ${e1.members.length} 个，代表条目 ${e1.id}`);
if (e1.members.length !== 4 || !e1.id.endsWith("/go/s1/e1")) {
  console.error("预期 E1 有 4 个成员、代表条目是甲源最新那条");
  process.exit(1);
}
const feed = fs.readdirSync("mock-output/debug").find((f) => f.startsWith("raw-"));
const raw = fs.readFileSync(`mock-output/debug/${feed}`, "utf8");
for (const junk of ["article_adlist", "责任编辑", "版权所有", "margin:0"]) {
  if (raw.includes(junk)) { console.error(`抓取后的摘要里还有未清掉的页面垃圾：${junk}`); process.exit(1); }
}
console.log("摘要垃圾清理、代表条目选取均符合预期");
'
grep -c "<item>" mock-output/feed.xml | sed "s/^/feed.xml item 数: /"
grep -o "<b>[^<]*家媒体报道[^<]*</b>" mock-output/feed.xml | head -3
