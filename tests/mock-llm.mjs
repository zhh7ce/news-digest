// 沙箱验证用假 LLM + 假订阅源，只在本地跑，不碰任何真实站点。
//
// GET  /feeds/<id>.xml      自己带的三份 fixture 源，同一事件在不同源里标题不同、链接不同
// POST /v1/chat/completions 按 prompt 里的 JSON 格式区分三种调用：
//   item   → {"title_zh","category"}：标题里的 [E7] 标记换成统一中文标题，跨源因此能对得上
//   merge  → {"assignments"}：按 E 编号分组，已有事件的编号能对上就给锚点，否则 n-<最小编号>
//            同时故意掺进非法输出（不存在的锚点、重复条目、漏掉最后一条）来验证严格校验
//   score  → {"score"}：按 E 编号给固定分，方便核对排序
// 另外每 7 条 item、每 5 次 score 回一次 HTTP 400 风控，用来验证"只丢它自己"。
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
// MOCK_CHAOS=0 时不再掺风控和非法输出，用来看干净路径（新报道并进已有事件）
const CHAOS = process.env.MOCK_CHAOS !== "0";

// category 用 "gossip" 的条目在 feeds 类别表之外，验证归类兜底
const EVENTS = [
  { ev: "E1", zh: "央行下调基准利率0.5个百分点", category: "world" },
  { ev: "E2", zh: "北方港特大暴雨致航道关闭三日", category: "world" },
  { ev: "E3", zh: "两国签署稀土出口新协议", category: "world" },
  { ev: "E4", zh: "开源推理框架发布 2.0 版本", category: "tech" },
  { ev: "E5", zh: "头部实验室公布多模态新模型", category: "tech" },
  { ev: "E6", zh: "数据中心液冷标准草案公开", category: "tech" },
  { ev: "E7", zh: "端侧芯片能效比提升四成", category: "tech" },
  { ev: "E8", zh: "编译器漏洞影响百万个项目", category: "tech" },
  { ev: "E9", zh: "热门剧集大结局引讨论", category: "hot" },
  { ev: "E10", zh: "热搜第一为高校毕业生就业", category: "hot" },
  { ev: "E11", zh: "社区投票反对旧城改造", category: "hot" },
  { ev: "E12", zh: "电竞联赛决赛落地本地", category: "hot" },
  { ev: "E13", zh: "体育场馆票价调整引争议", category: "hot" },
  { ev: "E14", zh: "多地推进老旧小区加装电梯", category: "china" },
  { ev: "E15", zh: "新修订野生动物保护法施行", category: "china" },
  { ev: "E16", zh: "跨省医保直接结算扩围", category: "china" },
  { ev: "E17", zh: "汛期防汛应急响应提升至三级", category: "china" },
  { ev: "E18", zh: "新能源汽车下乡活动启动", category: "china" },
  { ev: "E19", zh: "本机无类别归入其他甲", category: "other" },
  { ev: "E20", zh: "本机无类别归入其他乙", category: "other" },
  { ev: "E21", zh: "本机无类别归入其他丙", category: "other" },
  { ev: "E22", zh: "本机无类别归入其他丁", category: "other" },
  { ev: "E23", zh: "类别写在配置之外应被兜底", category: "gossip" },
  { ev: "E24", zh: "本地新地铁线开通首日客流三十万", category: "china" },
];

const BY_EV = new Map(EVENTS.map((e) => [e.ev, e]));

// 三个源：甲源优先级最高（有 E1 的一新一旧两条），乙源无 pubDate，丙源最靠后
const SOURCES = [
  {
    id: "s1",
    name: "甲源",
    category: "other",
    items: [
      { ev: "E1", slug: "e1-old", title: "快讯：央行宣布下调基准利率0.5个百分点", pub: "Wed, 09 Sep 2026 18:00:00 GMT" },
      { ev: "E1", title: "央行下调基准利率0.5个百分点（甲源更新）", pub: "Thu, 10 Sep 2026 18:00:00 GMT" },
      { ev: "E2", title: "北方港暴雨：航道已关闭三日", pub: "Thu, 10 Sep 2026 12:00:00 GMT" },
      { ev: "E3", title: "两国宣布签署稀土出口新协议", pub: "Thu, 10 Sep 2026 09:00:00 GMT" },
      { ev: "E4", title: "开源推理框架 2.0 发布说明", pub: "Thu, 10 Sep 2026 08:00:00 GMT" },
      { ev: "E5", title: "New model announced by top lab", pub: "Thu, 10 Sep 2026 07:00:00 GMT" },
      { ev: "E6", title: "液冷标准草案征求意见", pub: "Thu, 10 Sep 2026 06:00:00 GMT" },
      { ev: "E7", title: "端侧芯片能效比提升 40%", pub: "Thu, 10 Sep 2026 05:00:00 GMT" },
      { ev: "E8", title: "编译器漏洞波及百万项目", pub: "Thu, 10 Sep 2026 04:00:00 GMT" },
      { ev: "E9", title: "热门剧集大结局讨论度走高", pub: "Thu, 10 Sep 2026 03:00:00 GMT" },
      { ev: "E10", title: "高校毕业生就业登上热搜第一", pub: "Thu, 10 Sep 2026 02:00:00 GMT" },
      { ev: "E19", title: "甲源其他条目一", pub: "Thu, 10 Sep 2026 01:00:00 GMT" },
      { ev: "E23", title: "甲源越界类别条目", pub: "Thu, 10 Sep 2026 00:30:00 GMT" },
    ],
  },
  {
    id: "s2",
    name: "乙源",
    category: "world",
    // 故意不给时间：无日期的条目要排在有日期的后面，但不能被丢掉
    items: [
      { ev: "E1", title: "央行降息50个基点", junk: true },
      // 只在 MOCK_ROUND=2 出现：验证新报道能并进已有事件，且不抢走代表条目
      { ev: "E1", slug: "e1-later", title: "央行宣布降息50个基点（乙源快讯）", round: 2 },
      { ev: "E24", title: "新地铁线开通首日客流三十万", round: 2 },
      { ev: "E2", title: "特大暴雨侵袭北方港 航道关闭", junk: true },
      { ev: "E5", title: "顶级实验室发布多模态模型" },
      { ev: "E11", title: "旧城改造方案遭社区投票反对" },
      { ev: "E12", title: "电竞联赛决赛确定在本地举办" },
      { ev: "E13", title: "体育场馆票价调整引发争议" },
      { ev: "E14", title: "老旧小区加装电梯在多地推进" },
      { ev: "E15", title: "新修订野生动物保护法今起施行" },
      { ev: "E16", title: "跨省医保直接结算扩大范围" },
      { ev: "E17", title: "防汛应急响应提升至三级" },
      { ev: "E20", title: "乙源其他条目一" },
      { ev: "E21", title: "乙源其他条目二" },
    ],
  },
  {
    id: "s3",
    name: "丙源",
    category: "tech",
    items: [
      { ev: "E1", title: "PBOC cuts benchmark rate by 50 basis points", pub: "Thu, 10 Sep 2026 10:00:00 GMT" },
      { ev: "E3", title: "Rare earth export deal signed by two governments", pub: "Wed, 09 Sep 2026 20:00:00 GMT" },
      { ev: "E18", title: "新能源汽车下乡活动启动首批三十县" },
      { ev: "E22", title: "丙源其他条目一" },
    ],
  },
];

const JUNK =
  "据本站记者从现场获悉，事件进展如下&#8203;。body{margin:0;padding:0} 详细数据见正文 ]article_adlist--> ​责任编辑：王一​  Copyright © 2026 某某网 版权所有";
const PLAIN = "据公开报道，相关部门已通报进展，具体数字以正式公告为准。";

function feedXml(source, round) {
  const items = source.items
    .filter((item) => (item.round ?? 1) <= round)
    .map((item) => {
      const link = `${BASE}/go/${source.id}/${item.slug ?? item.ev.toLowerCase()}`;
      // 带 utm 参数的链接要归一到同一个键，验证 linkKey
      const url = item.ev === "E5" ? `${link}?utm_source=feed&ref=rs` : link;
      const date = item.pub ? `<pubDate>${item.pub}</pubDate>` : "";
      return [
        "    <item>",
        `      <title>[${item.ev}] ${item.title}</title>`,
        `      <link>${url.replace(/&/g, "&amp;")}</link>`,
        `      <guid isPermaLink="false">${url.replace(/&/g, "&amp;")}</guid>`,
        date,
        `      <description>${item.junk ? JUNK : PLAIN}</description>`,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${source.name}</title>
    <link>${BASE}/${source.id}</link>
    <description>mock feed ${source.id}</description>
${items}
  </channel>
</rss>
`;
}

let itemCalls = 0;
let scoreCalls = 0;
let mergeCalls = 0;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function reply(res, content) {
  json(res, 200, {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

// 云端风控：只拦这一条，重试也还是拦
function blocked(res) {
  json(res, 400, { error: { code: "10001", message: "该内容包含敏感信息，无法处理" } });
}

function evOf(text) {
  return text.match(/\bE\d+\b/)?.[0];
}

function handleItem(prompt) {
  const event = BY_EV.get(evOf(prompt));
  if (!event) {
    console.warn(`[mock] 条目里没有 E 编号，原样回标题：${prompt.slice(0, 120)}`);
    return JSON.stringify({ title_zh: `陌生条目 ${prompt.slice(0, 40)}`, category: "other" });
  }
  // E23 的类别在 feeds 类别表之外，检查是否落到源声明的类别
  return JSON.stringify({ title_zh: `事件${event.ev}：${event.zh}`, category: event.category });
}

function handleMerge(prompt) {
  mergeCalls += 1;
  const anchors = [...prompt.matchAll(/^- (a\d+)：事件(E\d+)：/gm)].map((m) => ({ id: m[1], ev: m[2] }));
  const items = [...prompt.matchAll(/^#(\d+) \[[^\]]*\] 事件(E\d+)：/gm)].map((m) => ({ id: m[1], ev: m[2] }));
  const anchorByEv = new Map(anchors.map((a) => [a.ev, a.id]));

  const byEv = new Map();
  for (const item of items) {
    const bucket = byEv.get(item.ev);
    if (bucket) bucket.push(item.id);
    else byEv.set(item.ev, [item.id]);
  }

  const assignments = [];
  for (const [ev, ids] of byEv) {
    const target = anchorByEv.get(ev) ?? `n-${ids.sort((a, b) => Number(a) - Number(b))[0]}`;
    for (const id of ids) assignments.push({ item: id, event: target });
  }

  // 故意掺进三类不合规矩的输出，程序侧要全部安全退回
  if (CHAOS && mergeCalls % 3 === 1 && assignments.length > 0) {
    assignments.push({ item: "9999", event: "a1" }); // 条目不存在
    assignments[0] = { ...assignments[0], event: "a404" }; // 锚点不存在
  }
  if (CHAOS && mergeCalls % 4 === 2 && assignments.length > 1) {
    assignments.push({ item: assignments[1].item, event: "a1" }); // 同一条目重复
    assignments.pop(); // 最后一条故意不报，检查"漏掉就自成一组"
  }
  return JSON.stringify({ assignments });
}

function handleScore(prompt) {
  scoreCalls += 1;
  if (CHAOS && scoreCalls % 5 === 0) return null; // 模拟逐事件打分被风控
  const ev = Number(evOf(prompt)?.slice(1) ?? 0);
  return JSON.stringify({ score: 1 + (ev % 6) });
}

function respond(res, prompt) {
  if (prompt.includes('"title_zh"')) {
    itemCalls += 1;
    if (CHAOS && itemCalls % 7 === 0) return blocked(res);
    return reply(res, handleItem(prompt));
  }
  if (prompt.includes("assignments")) {
    const content = handleMerge(prompt);
    // 每 5 次归并把整段回答写成废话，验证"解析不出来就整批自成一组"
    return reply(res, CHAOS && mergeCalls % 5 === 4 ? "抱歉，我无法输出 JSON。" : content);
  }
  const score = handleScore(prompt);
  if (score === null) return blocked(res);
  return reply(res, score);
}

createServer((req, res) => {
  const url = new URL(req.url, BASE);

  // /feeds/s1.xml 是第一轮；/feeds/r2/s1.xml 多出几条"这一轮刚出现"的报道
  const feedMatch = url.pathname.match(/^\/feeds\/(?:(r2)\/)?([\w-]+)\.xml$/);
  const feed = feedMatch ? SOURCES.find((source) => source.id === feedMatch[2]) : undefined;
  if (feed) {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    return res.end(feedXml(feed, feedMatch[1] ? 2 : 1));
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404);
    return res.end("not found");
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const prompt = JSON.parse(body).messages[0].content;
    respond(res, prompt);
  });
}).listen(PORT, () => {
  console.log(`mock llm on ${BASE}  (item=${itemCalls})`);
  console.log(`feeds: ${SOURCES.map((s) => `${BASE}/feeds/${s.id}.xml`).join(" ")}`);
});
