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
GH_PORT="${MOCK_GH_PORT:-8788}"
# 上一次崩溃残留的 mock 占着端口时，新实例静默绑不上、请求全打在旧进程上，
# 表现是断言莫名其妙地挂——先把本仓库的残留 mock 清掉，清不掉再拒跑
pkill -f "node .*tests/mock-(llm|github)\.mjs" 2>/dev/null || true
for P in "$PORT" "$GH_PORT"; do
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "http://127.0.0.1:$P/health" 2>/dev/null || break
    sleep 0.1
  done
  if curl -sf -o /dev/null "http://127.0.0.1:$P/health" 2>/dev/null; then
    echo "端口 $P 仍被占用，请先手动清掉残留进程" >&2
    exit 1
  fi
done

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

# 第二个参数起是附加的环境变量覆盖（如 PAGES_* / FEED_URL）
run() {
  env -u http_proxy -u https_proxy no_proxy="127.0.0.1,localhost" \
    FEEDS_CONFIG="$1" \
    LLM_API_BASE="http://127.0.0.1:$PORT/v1" \
    LLM_API_KEY=mock LLM_MODEL=mock LLM_CONCURRENCY=4 LLM_RETRIES=0 \
    DIGEST_DUMP=1 \
    "${@:2}" \
    node src/digest.ts 2>&1 | grep -E '^\[(fetch|run|item|merge|score|state|pages)'
}

rm -rf mock-output mock-state
mkdir -p mock-output/sources
# 第三轮的源列表只把 URL 换成 /feeds/r2/...，假源里多出两条"这一轮刚出现"的报道
sed 's|/feeds/|/feeds/r2/|' tests/mock-feeds.yaml > mock-output/feeds-round3.yaml
sed 's|/feeds/|/feeds/r2/|' tests/sources/sources.yaml > mock-output/sources/sources.yaml

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

echo
echo "== GitHub Pages 发布（假 GitHub，不碰真实仓库）=="
GH_ENV=(
  PAGES_API_BASE="http://127.0.0.1:$GH_PORT"
  PAGES_REPO=zhh7ce/zhh7ce.github.io
  PAGES_BRANCH=main
  PAGES_DIR=static/news-digest
  PAGES_TOKEN=mock-token
  FEED_URL=https://zhh7ce.github.io/static/news-digest/feed.xml
)
node tests/mock-github.mjs "$GH_PORT" >/dev/null 2>&1 &
GH_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$GH_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done

# 第四轮：三者齐全，流水线末尾应把两份产物 PUT 上去；在 debug/ 放假文件确认它不上台
touch mock-output/debug/leak-check.bin
run tests/mock-feeds.yaml "${GH_ENV[@]}"

# 缺任一项就是不发布（不是报错）：token 清空后 pages 必须是 undefined
FEED_URL="https://zhh7ce.github.io/static/news-digest/feed.xml" PAGES_TOKEN= node --input-type=module -e '
const { loadConfig } = await import("./src/lib/config.ts");
const root = process.cwd();
const combos = [
  { which: "缺 token", env: { PAGES_REPO: "a/b", PAGES_DIR: "d", PAGES_TOKEN: "" } },
  { which: "缺 repo", env: { PAGES_REPO: "", PAGES_DIR: "d", PAGES_TOKEN: "t" } },
  { which: "缺 dir", env: { PAGES_REPO: "a/b", PAGES_DIR: "", PAGES_TOKEN: "t" } },
];
for (const c of combos) {
  for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
  const config = loadConfig(root);
  if (config.pages !== undefined) { console.error(`${c.which} 时 pages 应是 undefined`); process.exit(1); }
}
for (const [k, v] of Object.entries(combos[0].env)) process.env[k] = v;
process.env.PAGES_TOKEN = "t";
process.env.PAGES_REPO = "只有仓库名没有 owner";
let threw = false;
try { loadConfig(root); } catch { threw = true; }
if (!threw) { console.error("PAGES_REPO 不形如 owner/name 时应抛错"); process.exit(1); }
console.log("三种缺项组合 pages 均为 undefined，非法 PAGES_REPO 会抛错");
'

node --input-type=module -e '
import * as fs from "node:fs";
const lines = fs.readFileSync("mock-output/pages-upload.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const puts = lines.filter((l) => l.method === "PUT");
if (puts.length !== 2) { console.error(`期望 2 次 PUT，实际 ${puts.length}`); process.exit(1); }
const relative = (l) => decodeURIComponent(l.path.split("/contents/")[1].replace(/^static\/news-digest\//, ""));
const names = puts.map(relative).sort().join(" ");
if (names !== "digest.md feed.xml") { console.error(`上传清单不对：${names}`); process.exit(1); }
if (!puts.every((l) => l.path.startsWith("/repos/zhh7ce/zhh7ce.github.io/contents/static/news-digest/"))) {
  console.error("PUT 路径前缀不是 static/news-digest"); process.exit(1);
}
for (const p of puts) {
  const expected = fs.readFileSync(`mock-output/${relative(p)}`);
  const uploaded = Buffer.from(JSON.parse(p.body).content, "base64");
  if (!uploaded.equals(expected)) { console.error(`${relative(p)} 上传内容与本地文件不一致`); process.exit(1); }
}
if (lines.some((l) => l.path.includes("leak-check"))) { console.error("debug 产物被上传了"); process.exit(1); }
console.log("PUT 恰 2 次、路径前缀与 base64 内容逐字节相符，debug 假文件未上台");
'

# 409 分支：首次 GET 回旧 sha、首个 PUT 回 409、二次 GET 回新 sha
# 必须先关掉正常模式的实例再起 conflict 实例，否则端口被占、请求全打在旧实例上
kill $GH_PID 2>/dev/null || true
wait $GH_PID 2>/dev/null || true
rm -f mock-output/pages-upload-conflict.jsonl
MOCK_GH_MODE=conflict MOCK_GH_LOG=mock-output/pages-upload-conflict.jsonl \
  node tests/mock-github.mjs "$GH_PORT" >/dev/null 2>&1 &
GH_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$GH_PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done
env -u http_proxy -u https_proxy no_proxy="127.0.0.1,localhost" \
  "${GH_ENV[@]}" \
  node --input-type=module -e "
const { publishFiles } = await import('./src/lib/pages.ts');
const pages = {
  apiBase: process.env.PAGES_API_BASE,
  repo: process.env.PAGES_REPO,
  branch: process.env.PAGES_BRANCH,
  dir: process.env.PAGES_DIR,
  token: process.env.PAGES_TOKEN,
};
await publishFiles('mock-output', ['feed.xml'], pages);
" 2>&1 | grep -E '^\[pages'

node --input-type=module -e '
import * as fs from "node:fs";
const lines = fs.readFileSync("mock-output/pages-upload-conflict.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const seq = lines.map((l) => l.method).join(" ");
if (seq !== "GET PUT GET PUT") { console.error(`409 后应恰重取一次 sha 再 PUT，实际请求序列：${seq}`); process.exit(1); }
console.log("409 分支符合预期：重取 sha、只重试一次");
'
kill $GH_PID 2>/dev/null || true
wait $GH_PID 2>/dev/null || true

grep -c "<item>" mock-output/feed.xml | sed "s/^/feed.xml item 数: /"
grep -o "<b>[^<]*家媒体报道[^<]*</b>" mock-output/feed.xml | head -3
