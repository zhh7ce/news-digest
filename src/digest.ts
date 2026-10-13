import * as fs from "node:fs";
import * as path from "node:path";
import { categoryIds, categoryListText, loadConfig, type Category, type Config, type SortBy } from "./lib/config.ts";
import { rankOf, sourceCount, voteCategory } from "./lib/event.ts";
import { fetchAllSources, publishedTimeMs, type Article } from "./lib/fetch.ts";
import { extractJson, isContentFiltered, LlmClient } from "./lib/llm.ts";
import {
  bucketAssignments,
  buildAnchorRows,
  buildItemRows,
  chunk,
  parseAssignments,
  parseScore,
  renderAnchors,
  renderItems,
  type MergeAnchor,
  type MergeItem,
} from "./lib/merge.ts";
import {
  groupByCategory,
  renderMarkdown,
  renderRss,
  type DigestEvent,
  type EventGroup,
  type FeedMeta,
} from "./lib/render.ts";
import { linkKey, loadStore, saveStore, textHash, type EventRecord, type Store } from "./lib/state.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PER_CATEGORY = 20;
const DEFAULT_RETENTION_DAYS = 7;
const FALLBACK_CATEGORY = "other";
/** 归并和打分 prompt 里最多列几条报道标题，再多只是费 token */
const MAX_TITLES_IN_PROMPT = 8;
/** 逐条标注只需认标题，摘要截短一点省 token */
const ITEM_DESC_CHARS = 160;

/** 在架条目 + 它的标注结果 */
interface ShelfItem {
  key: string;
  article: Article;
  /** AI 给的中文标题（被风控时是原标题），归并时喂给模型的就是它 */
  titleZh: string;
  /** AI 给的类别（被风控时是源声明的类别） */
  category: string;
}

interface LlmCallRecord {
  seq: number;
  prompt: string;
  response: string | null;
  error: string | null;
}

function renderCalls(calls: LlmCallRecord[]): string {
  return calls
    .map((call) =>
      [
        `===== 调用 #${call.seq} =====`,
        `[prompt]`,
        call.prompt,
        `[response]`,
        call.error ? `(请求失败) ${call.error}` : (call.response ?? "(空)"),
      ].join("\n"),
    )
    .join("\n\n");
}

function dumpText(dir: string | null, filename: string, text: string): void {
  if (!dir) return;
  fs.writeFileSync(path.join(dir, filename), text, "utf8");
}

/** --dump / DIGEST_DUMP=1：除了写 debug 文件，stdout 也逐批打出 AI 请求进度 */
let debugMode = false;

function setDebugMode(on: boolean): void {
  debugMode = on;
}

function debugLog(line: string): void {
  if (debugMode) console.log(`[debug] ${line}`);
}

/** 打进度的标题一律压成一行并截短，避免刷屏 */
function shortText(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function resolveCategory(categories: Category[], proposed: string | undefined, article: Article): string {
  const ids = categoryIds(categories);
  if (proposed && ids.includes(proposed)) return proposed;
  if (ids.includes(article.sourceCategory)) return article.sourceCategory;
  return ids.includes(FALLBACK_CATEGORY) ? FALLBACK_CATEGORY : categories[categories.length - 1].id;
}

function dedupeByLink(articles: Article[]): Article[] {
  const map = new Map<string, Article>();
  for (const article of articles) {
    const key = linkKey(article.link);
    const existing = map.get(key);
    if (!existing || article.description.length > existing.description.length) map.set(key, article);
  }
  return Array.from(map.values());
}

/** 按"优先级最高的源、同源取最新"排序成员键 */
function orderMemberKeys(keys: string[], shelf: Map<string, ShelfItem>, sourceOrder: Map<string, number>): string[] {
  return keys.slice().sort((a, b) => {
    const left = shelf.get(a)?.article;
    const right = shelf.get(b)?.article;
    if (!left || !right) return 0;
    return rankOf(sourceOrder, left) - rankOf(sourceOrder, right) || publishedTimeMs(right) - publishedTimeMs(left);
  });
}

/**
 * 逐条标注：一条新闻一次请求，只要中文标题和类别。
 * 缓存里已有且标题没变的条目直接复用；这一趟同时是风控探针。
 * enabled=false（LLM_ANNOTATE=0）时一条都不发：标题用原文、类别取该源声明的 category。
 */
async function annotate(
  articles: Article[],
  store: Store,
  llm: LlmClient,
  promptTemplate: string,
  categories: Category[],
  enabled: boolean,
): Promise<{ shelf: ShelfItem[]; reused: number; filtered: number; failed: number; calls: LlmCallRecord[] }> {
  const now = new Date().toISOString();
  const calls: LlmCallRecord[] = [];

  if (!enabled) {
    const shelf: ShelfItem[] = articles.map((article) => ({
      key: linkKey(article.link),
      article,
      titleZh: article.title,
      category: resolveCategory(categories, undefined, article),
    }));
    return { shelf, reused: 0, filtered: 0, failed: 0, calls };
  }

  const pending: Article[] = [];
  let reused = 0;

  for (const article of articles) {
    const record = store.items[linkKey(article.link)];
    if (record && record.titleHash === textHash(article.title)) {
      record.lastSeen = now;
      reused += 1;
    } else {
      pending.push(article);
    }
  }

  let filtered = 0;
  let failed = 0;
  if (pending.length > 0) {
    debugLog(`item 逐条标注 ${pending.length} 条（缓存命中 ${reused} 条），一条一问`);
    let done = 0;
    const categoryText = categoryListText(categories);
    const results = await Promise.all(
      pending.map((article, seq) => {
        const prompt = promptTemplate
          .replaceAll("{{categories}}", categoryText)
          .replaceAll(
            "{{article}}",
            `#${seq} [${article.sourceName}] ${article.title}\n${article.description.slice(0, ITEM_DESC_CHARS)}`,
          );

        return llm.complete(prompt).then(
          (response) => {
            calls.push({ seq, prompt, response, error: null });
            debugLog(`item ${++done}/${pending.length} 请求 #${seq + 1} [${article.sourceName}] ${shortText(article.title)} ✓`);
            return { article, response, error: null as string | null, sensitive: false };
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const sensitive = isContentFiltered(error);
            calls.push({ seq, prompt, response: null, error: message });
            debugLog(
              `item ${++done}/${pending.length} 请求 #${seq + 1} [${article.sourceName}] ${shortText(article.title)} ${
                sensitive ? "被风控，用原标题兜底" : `失败：${message}`
              }`,
            );
            return { article, response: null, error: message, sensitive };
          },
        );
      }),
    );

    for (const result of results) {
      const key = linkKey(result.article.link);
      if (result.error !== null) {
        if (result.sensitive) {
          // 重试也都会被拦，记下原标题和源类别，下一轮不再请求
          filtered += 1;
          store.items[key] = {
            titleHash: textHash(result.article.title),
            titleZh: result.article.title,
            category: resolveCategory(categories, undefined, result.article),
            lastSeen: now,
            filtered: true,
          };
        } else {
          failed += 1;
        }
        continue;
      }

      let parsed: { title_zh?: string; category?: string } | undefined;
      try {
        parsed = extractJson<{ title_zh?: string; category?: string }>(result.response ?? "");
      } catch {
        parsed = undefined;
      }

      store.items[key] = {
        titleHash: textHash(result.article.title),
        titleZh: parsed?.title_zh?.trim() || result.article.title,
        category: resolveCategory(categories, parsed?.category, result.article),
        lastSeen: now,
      };
    }
  }
  calls.sort((a, b) => a.seq - b.seq);

  const shelf: ShelfItem[] = [];
  for (const article of articles) {
    const key = linkKey(article.link);
    const record = store.items[key];
    if (!record) continue;
    shelf.push({ key, article, titleZh: record.titleZh, category: record.category });
  }

  return { shelf, reused, filtered, failed, calls };
}

/** 事件集合的可变工作区：成员并组、整组搬迁都在这里 */
class EventWorkspace {
  private readonly events = new Map<string, EventRecord>();
  private readonly memberIndex = new Map<string, string>();

  constructor(records: EventRecord[]) {
    for (const record of records) {
      this.events.set(record.id, record);
      for (const member of record.members) this.memberIndex.set(member, record.id);
    }
  }

  get(id: string): EventRecord | undefined {
    return this.events.get(id);
  }

  eventOf(memberKey: string): string | undefined {
    return this.memberIndex.get(memberKey);
  }

  list(): EventRecord[] {
    return Array.from(this.events.values());
  }

  /** 新建事件，id 用成员排序后的第一个（即代表条目的链接） */
  create(members: string[], titleZh: string, category: string, now: string): EventRecord {
    const id = members[0];
    const record: EventRecord = { id, titleZh, category, members: [], lastSeen: now };
    this.events.set(id, record);
    for (const key of members) this.addMember(record, key, now);
    return record;
  }

  addMember(target: EventRecord, key: string, now: string): void {
    const current = this.memberIndex.get(key);
    if (current === target.id) {
      target.lastSeen = now;
      return;
    }
    // 这个成员已经属于别的事件，整组搬过来，旧事件消失
    if (current) this.absorb(current, target, now);

    if (!target.members.includes(key)) target.members.push(key);
    this.memberIndex.set(key, target.id);
    target.lastSeen = now;
  }

  mergeInto(targetId: string, sourceId: string, now: string): void {
    const target = this.events.get(targetId);
    if (!target) return;
    this.absorb(sourceId, target, now);
  }

  private absorb(sourceId: string, target: EventRecord, now: string): void {
    const source = this.events.get(sourceId);
    if (!source || source.id === target.id) return;
    for (const key of source.members) {
      if (!target.members.includes(key)) target.members.push(key);
      this.memberIndex.set(key, target.id);
    }
    this.events.delete(sourceId);
    target.lastSeen = now;
  }
}

/** 锚点：只送还在架、且不在本批条目里的事件；category 传 undefined 表示跨类别 */
function anchorsFor(
  workspace: EventWorkspace,
  shelf: Map<string, ShelfItem>,
  category: string | undefined,
  exclude: Set<string>,
): MergeAnchor[] {
  return workspace
    .list()
    .filter(
      (event) =>
        event.titleZh &&
        (category === undefined || event.category === category) &&
        !exclude.has(event.id) &&
        event.members.some((key) => shelf.has(key)),
    )
    .map((event) => ({ key: event.id, title: event.titleZh }));
}

/**
 * 一次归并请求：条目和锚点都渲染成短编号（锚点 a1、a2…，条目 1、2…），
 * 模型只回编号，不合规的输出全在 parseAssignments 里退回自成一组，不重问。
 */
async function runMerge(
  config: Config,
  llm: LlmClient,
  category: string | undefined,
  anchors: MergeAnchor[],
  items: MergeItem[],
  seq: number,
): Promise<{
  toAnchor: Array<{ anchorKey: string; key: string }>;
  newGroups: Map<string, string[]>;
  call: LlmCallRecord;
}> {
  const anchorRows = buildAnchorRows(anchors);
  const itemRows = buildItemRows(items, 1);
  const prompt = config.prompts.merge
    .replaceAll("{{category}}", category ?? "（本轮新建的事件）")
    .replaceAll("{{anchors}}", renderAnchors(anchorRows))
    .replaceAll("{{items}}", renderItems(itemRows));

  const response = await llm.complete(prompt).catch(() => null);
  const assignments = parseAssignments(response ?? "", { items: itemRows, anchors: anchorRows });
  return {
    ...bucketAssignments(assignments, itemRows.map((row) => row.key)),
    call: {
      seq,
      prompt,
      response,
      error: response === null ? "请求失败：这一批条目全部自成一组" : null,
    },
  };
}

/** 新组：成员按"优先级最高的源、同源取最新"排序，第一个就是代表条目 */
function createEvents(
  newGroups: Map<string, string[]>,
  category: string,
  shelf: Map<string, ShelfItem>,
  sourceOrder: Map<string, number>,
  workspace: EventWorkspace,
  now: string,
): string[] {
  const created: string[] = [];
  for (const members of newGroups.values()) {
    const ordered = orderMemberKeys(members, shelf, sourceOrder);
    const lead = shelf.get(ordered[0]);
    created.push(workspace.create(ordered, lead?.titleZh ?? "", category, now).id);
  }
  return created;
}

/** 事件内最新的报道时间；完全没有日期信息的源算 0，排在有日期的之后 */
function newestPublishedMs(event: DigestEvent): number {
  return event.articles.reduce((max, article) => Math.max(max, publishedTimeMs(article)), 0);
}

const bySourceCount = (a: DigestEvent, b: DigestEvent) => b.sources - a.sources;
const byScore = (a: DigestEvent, b: DigestEvent) => b.score - a.score;
const byRecency = (a: DigestEvent, b: DigestEvent) => newestPublishedMs(b) - newestPublishedMs(a);

/** 前两个键按 SORT_BY 换序，第三键固定是事件内最新报道时间 */
function compareEvents(sortBy: SortBy) {
  const [first, second] = sortBy === "score" ? [byScore, bySourceCount] : [bySourceCount, byScore];
  return (a: DigestEvent, b: DigestEvent) => first(a, b) || second(a, b) || byRecency(a, b);
}

function sortLabel(sortBy: SortBy): string {
  const keys = sortBy === "score" ? ["AI 分数", "独立来源数"] : ["独立来源数", "AI 分数"];
  return `${keys[0]} → ${keys[1]} → 事件最新报道时间`;
}

/** 达到最低门槛的事件必留，不占每类的名额；门槛为 0 表示这个维度不设门槛 */
function isMustKeep(event: DigestEvent, minScore: number, minSources: number): boolean {
  return (minScore > 0 && event.score >= minScore) || (minSources > 0 && event.sources >= minSources);
}

/** 按排序口径排好，再截断：必留的不占名额，其余每类最多 maxPerCategory 条 */
function trimGroup(
  events: DigestEvent[],
  compare: (a: DigestEvent, b: DigestEvent) => number,
  maxPerCategory: number,
  minScore: number,
  minSources: number,
): DigestEvent[] {
  let quota = maxPerCategory;
  const kept: DigestEvent[] = [];
  for (const event of events.slice().sort(compare)) {
    if (isMustKeep(event, minScore, minSources)) {
      kept.push(event);
    } else if (quota > 0) {
      quota -= 1;
      kept.push(event);
    }
  }
  return kept;
}

function rankGroups(
  events: DigestEvent[],
  categories: Category[],
  maxPerCategory: number,
  sortBy: SortBy,
  minScore: number,
  minSources: number,
): EventGroup[] {
  const compare = compareEvents(sortBy);
  return groupByCategory(events, categories)
    .map((group) => ({ ...group, events: trimGroup(group.events, compare, maxPerCategory, minScore, minSources) }))
    .filter((group) => group.events.length > 0);
}

/** 必留门槛的说明，门槛都为 0 时说明没有必留逻辑 */
function keepLabel(maxPerCategory: number, minScore: number, minSources: number): string {
  const parts: string[] = [];
  if (minScore > 0) parts.push(`分数 ≥ ${minScore}`);
  if (minSources > 0) parts.push(`独立来源数 ≥ ${minSources}`);
  if (parts.length === 0) return `无必留门槛，每类最多 ${maxPerCategory} 条`;
  return `${parts.join(" 或 ")} 的事件必留，不占每类 ${maxPerCategory} 条的名额`;
}

interface RunStats {
  okFeeds: number;
  failedFeeds: number;
  totalArticles: number;
  eventCount: number;
  maxItemsPerCategory: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地时间标签：dateTag 给 debug 文件用（精确到天），minuteTag 给最终输出用（精确到分钟） */
function localTags(now: Date): { dateTag: string; minuteTag: string } {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return { dateTag: date, minuteTag: `${date}-${pad2(now.getHours())}${pad2(now.getMinutes())}` };
}

/**
 * 每次运行写四份：feed-<分钟>.xml / digest-<分钟>.md 留档，
 * feed.xml / digest.md 永远是最新一份，订阅地址只用这两个。
 */
function writeOutput(
  groups: EventGroup[],
  config: Config,
  outputDir: string,
  minuteTag: string,
  stats: RunStats,
): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const meta: FeedMeta = {
    title: config.settings.feedTitle,
    description: config.settings.feedDescription,
    selfUrl: `${config.settings.siteBaseUrl || `file://${outputDir}`}/feed.xml`,
    buildDate: new Date(),
  };

  const rss = renderRss(groups, meta, config.settings.siteBaseUrl);
  const markdown = renderMarkdown(groups, meta, {
    ...stats,
    minScore: config.minScore,
    minSources: config.minSources,
  });

  const files: Array<[string, string]> = [
    [`feed-${minuteTag}.xml`, rss],
    ["feed.xml", rss],
    [`digest-${minuteTag}.md`, markdown],
    ["digest.md", markdown],
  ];
  for (const [name, text] of files) {
    const file = path.join(outputDir, name);
    // 先写同目录临时文件再 rename 覆盖：rename 在同一文件系统上是原子的，
    // serve 端要么读到旧的完整一份、要么读到新的完整一份，绝不会读到写一半的 feed.xml
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
    console.log(`[done] ${file}`);
  }
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const config = loadConfig(projectRoot);
  const { settings } = config;

  const args = process.argv.slice(2);
  const { dateTag, minuteTag } = localTags(new Date());
  const outputDir = path.resolve(projectRoot, settings.outputDir);
  const stateDir = path.resolve(projectRoot, settings.stateDir);

  let dumpDir: string | null = null;
  if (args.includes("--dump") || process.env.DIGEST_DUMP === "1") {
    dumpDir = path.join(outputDir, "debug");
    fs.mkdirSync(dumpDir, { recursive: true });
    setDebugMode(true);
    console.log(`[dump] 原始抓取与每一次 AI 调用的 prompt/响应写入 ${dumpDir}`);
    console.log(`[dump] 同时打出 [debug] 行：逐条标注逐条打，归并逐批打，打分逐事件打`);
  }

  const llm = new LlmClient({
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.llm.temperature,
    concurrency: config.llmConcurrency,
    retries: config.llmRetries,
    rpm: config.llmRpm,
    thinking: config.llmThinking,
  });
  console.log(
    `[llm] 并发 ${config.llmConcurrency}，每分钟上限 ${config.llmRpm > 0 ? `${config.llmRpm} 个请求` : "不限"}，` +
      `思考模式 ${config.llmThinking === "disabled" ? "关闭" : config.llmThinking === "enabled" ? "开启" : "服务端默认"}`,
  );
  console.log(`[run] 排序：${sortLabel(config.sortBy)}`);

  const batchSize = settings.mergeBatchSize ?? DEFAULT_BATCH_SIZE;
  const maxPerCategory = settings.maxItemsPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
  console.log(`[run] 必留门槛：${keepLabel(maxPerCategory, config.minScore, config.minSources)}`);
  if (config.minScore > 0 && !config.llmScore) {
    console.warn(`[warn] LLM_SCORE=0：所有事件都是 0 分，分数门槛 ≥ ${config.minScore} 不会有事件命中`);
  }
  const retentionDays = settings.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = new Date().toISOString();
  const sourceOrder = new Map(config.sources.map((source, index) => [source.id, index]));

  console.log(`[run] 抓取 ${config.sources.length} 个源，每源最多 ${settings.maxItemsPerFeed} 条，全量不按时间过滤`);
  const { articles, okFeeds, failedFeeds } = await fetchAllSources(config.sources, settings);
  const deduped = dedupeByLink(articles);
  console.log(`[run] 抓到 ${articles.length} 条，按链接去重后 ${deduped.length} 条`);

  if (dumpDir) {
    const raw = {
      generatedAt: now,
      okFeeds,
      failedFeeds,
      total: articles.length,
      articles: articles.map((a) => ({
        sourceId: a.sourceId,
        sourceName: a.sourceName,
        sourceCategory: a.sourceCategory,
        title: a.title,
        link: a.link,
        pubDate: a.pubDate,
        isoDate: a.isoDate,
        description: a.description,
      })),
    };
    fs.writeFileSync(path.join(dumpDir, `raw-${dateTag}.json`), JSON.stringify(raw, null, 2), "utf8");
  }

  if (!llm.configured) {
    console.warn("[warn] 未设置 LLM_API_KEY / LLM_MODEL：跳过标注、归并和打分，按源顺序直出原始列表");
    const groups = rankGroups(
      deduped.map((article) => ({
        category: resolveCategory(config.categories, undefined, article),
        title: article.title,
        summary: article.description,
        score: 0,
        sources: 1,
        articles: [article],
      })),
      config.categories,
      maxPerCategory,
      config.sortBy,
      config.minScore,
      config.minSources,
    );
    writeOutput(groups, config, outputDir, minuteTag, {
      okFeeds: okFeeds.length,
      failedFeeds: failedFeeds.length,
      totalArticles: deduped.length,
      eventCount: deduped.length,
      maxItemsPerCategory: maxPerCategory,
    });
    return;
  }

  const store = loadStore(stateDir);
  const annotated = await annotate(
    deduped,
    store,
    llm,
    config.prompts.item,
    config.categories,
    config.llmAnnotate,
  );
  dumpText(dumpDir, `llm-item-${dateTag}.txt`, renderCalls(annotated.calls));
  if (!config.llmAnnotate)
    console.log(`[item] 逐条标注已关闭（LLM_ANNOTATE=0）：标题用原文，分类用消息源声明的 category，在架 ${deduped.length} 条`);
  else
    console.log(
      `[item] 在架 ${deduped.length} 条：缓存复用 ${annotated.reused} 条，新请求 ${deduped.length - annotated.reused} 条` +
        `（风控用原标题兜底 ${annotated.filtered} 条，请求失败本轮跳过 ${annotated.failed} 条）`,
    );

  const shelf = new Map<string, ShelfItem>();
  for (const item of annotated.shelf) shelf.set(item.key, item);

  const workspace = new EventWorkspace(Object.values(store.events));
  const unmatched = annotated.shelf.filter((item) => workspace.eventOf(item.key) === undefined);
  console.log(`[merge] 已有事件 ${workspace.list().length} 个，需要归并的新条目 ${unmatched.length} 条`);

  const mergeCalls: LlmCallRecord[] = [];
  let seq = 0;
  let createdCount = 0;
  if (unmatched.length > 0) {
    // 同类别的条目和同类别的锚点进同一个 prompt，批次之间顺序执行，前面新建的事件立刻能做锚点
    const byCategory = new Map<string, ShelfItem[]>();
    for (const item of unmatched) {
      const bucket = byCategory.get(item.category);
      if (bucket) bucket.push(item);
      else byCategory.set(item.category, [item]);
    }

    const firstPassBatches = [...byCategory.values()].reduce(
      (total, items) => total + Math.ceil(items.length / batchSize),
      0,
    );
    debugLog(`merge 第一趟共 ${firstPassBatches} 批：${unmatched.length} 条新条目按类别切，每批最多 ${batchSize} 条`);
    let batchDone = 0;
    for (const [category, items] of byCategory) {
      for (const batch of chunk(items, batchSize)) {
        const mergeItems: MergeItem[] = batch.map((item) => ({
          key: item.key,
          title: item.titleZh,
          sourceName: item.article.sourceName,
        }));
        const anchors = anchorsFor(workspace, shelf, category, new Set(batch.map((item) => item.key)));
        const no = ++batchDone;
        debugLog(
          `merge 第一趟 批 ${no}/${firstPassBatches} 类别=${category} 锚点 ${anchors.length} 个 条目 ${batch.length} 条，发送中…`,
        );
        const outcome = await runMerge(config, llm, category, anchors, mergeItems, seq);
        mergeCalls.push(outcome.call);
        debugLog(
          `merge 第一趟 批 ${no}/${firstPassBatches} 完成：并入已有事件 ${outcome.toAnchor.length} 条，新建 ${outcome.newGroups.size} 组`,
        );

        for (const { anchorKey, key } of outcome.toAnchor) {
          const target = workspace.get(anchorKey);
          if (target && shelf.has(key)) workspace.addMember(target, key, now);
        }
        createdCount += createEvents(outcome.newGroups, category, shelf, sourceOrder, workspace, now).length;
        seq += 1;
      }
    }
  }

  // 二次归并：不同类别、不同批次各自新建的事件互相看不到，这一趟只比这些新事件
  const unmatchedKeys = new Set(unmatched.map((item) => item.key));
  const fresh = workspace.list().filter((event) => event.members.every((key) => unmatchedKeys.has(key)));
  const secondPassBatches = chunk(fresh, batchSize);
  let secondDone = 0;
  if (secondPassBatches.length > 0) {
    debugLog(`merge 二次归并共 ${secondPassBatches.length} 批：本轮新建的 ${fresh.length} 个事件跨类别互相比`);
  }
  for (const batch of secondPassBatches) {
    const mergeItems: MergeItem[] = [];
    for (const record of batch) {
      const lead = shelf.get(record.members[0] ?? "");
      if (!lead) continue;
      mergeItems.push({ key: record.id, title: record.titleZh, sourceName: lead.article.sourceName });
    }
    if (mergeItems.length < 2) {
      debugLog(`merge 二次归并 批 ${++secondDone}/${secondPassBatches.length} 只有 ${mergeItems.length} 个事件，跳过`);
      continue;
    }

    const anchors = anchorsFor(workspace, shelf, undefined, new Set(batch.map((record) => record.id)));
    const no = ++secondDone;
    debugLog(
      `merge 二次归并 批 ${no}/${secondPassBatches.length} 跨类别 锚点 ${anchors.length} 个 事件 ${mergeItems.length} 个，发送中…`,
    );
    const outcome = await runMerge(config, llm, undefined, anchors, mergeItems, seq);
    mergeCalls.push(outcome.call);
    debugLog(
      `merge 二次归并 批 ${no}/${secondPassBatches.length} 完成：并入已有事件 ${outcome.toAnchor.length} 个，并出新组 ${outcome.newGroups.size} 个`,
    );

    for (const { anchorKey, key } of outcome.toAnchor) workspace.mergeInto(anchorKey, key, now);
    for (const members of outcome.newGroups.values()) {
      const target = members.reduce((a, b) => (a < b ? a : b));
      for (const member of members) if (member !== target) workspace.mergeInto(target, member, now);
    }
    seq += 1;
  }
  dumpText(dumpDir, `llm-merge-${dateTag}.txt`, renderCalls(mergeCalls));
  console.log(`[merge] 新建 ${createdCount} 个候选事件，二次归并比较 ${fresh.length} 个`);

  const prepared: { record: EventRecord; articles: Article[]; representative: Article }[] = [];
  for (const record of workspace.list()) {
    const live = record.members
      .map((key) => shelf.get(key)?.article)
      .filter((article): article is Article => article !== undefined);
    if (live.length === 0) continue;

    const ordered = live
      .slice()
      .sort((a, b) => rankOf(sourceOrder, a) - rankOf(sourceOrder, b) || publishedTimeMs(b) - publishedTimeMs(a));
    const representative = ordered[0];
    record.members = ordered.map((article) => linkKey(article.link));
    record.category = voteCategory(
      ordered,
      (article) => shelf.get(linkKey(article.link))?.category ?? article.sourceCategory,
      sourceOrder,
    );
    record.titleZh = shelf.get(linkKey(representative.link))?.titleZh ?? representative.title;
    record.lastSeen = now;
    prepared.push({ record, articles: ordered, representative });
  }

  const scoreCalls: LlmCallRecord[] = [];
  if (config.llmScore) {
    const unscored = prepared.filter((item) => item.record.scoredAt === undefined);
    console.log(`[score] 新事件打分 ${unscored.length} 个，已打过的用缓存`);
    debugLog(`score 逐事件打分 ${unscored.length} 个事件，一问一事件`);
    let scoreDone = 0;
    await Promise.all(
      unscored.map(async (item, index) => {
        const prompt = config.prompts.score
          .replaceAll("{{profile}}", config.profile)
          .replaceAll("{{category}}", item.record.category)
          .replaceAll("{{title}}", item.record.titleZh)
          .replaceAll("{{summary}}", item.representative.description || "（无摘要）")
          .replaceAll("{{sources}}", String(sourceCount(item.articles)))
          .replaceAll(
            "{{articles}}",
            item.articles
              .slice(0, MAX_TITLES_IN_PROMPT)
              .map((article) => `- [${article.sourceName}] ${article.title}`)
              .join("\n"),
          );

        const response = await llm.complete(prompt).catch(() => null);
        scoreCalls.push({ seq: index, prompt, response, error: response === null ? "请求失败：本轮不记分" : null });
        const score = response === null ? undefined : parseScore(response);
        if (score !== undefined) {
          item.record.score = score;
          item.record.scoredAt = now;
        }
        debugLog(
          `score ${++scoreDone}/${unscored.length} 请求 #${index + 1} 类别=${item.record.category} ` +
            `${item.articles.length} 条报道 ${shortText(item.record.titleZh)} → ` +
            (score !== undefined
              ? `${score.toFixed(1)} 分`
              : response === null
                ? "请求失败，本轮不记分"
                : `没解析出分数，本轮不记分（响应：${shortText(response ?? "", 60)}）`),
        );
      }),
    );
  } else {
    console.log(
      `[score] 逐事件打分已关闭（LLM_SCORE=0）：${prepared.length} 个事件全部记 0 分，排序按独立来源数 → 事件最新报道时间`,
    );
  }
  dumpText(dumpDir, `llm-score-${dateTag}.txt`, renderCalls(scoreCalls));

  const events: DigestEvent[] = prepared.map((item) => ({
    category: item.record.category,
    title: item.representative.title,
    summary: item.representative.description,
    score: config.llmScore ? (item.record.score ?? 0) : 0,
    sources: sourceCount(item.articles),
    articles: item.articles,
  }));

  const groups = rankGroups(events, config.categories, maxPerCategory, config.sortBy, config.minScore, config.minSources);
  console.log(`[run] ${events.length} 个事件 → ${groups.map((g) => `${g.name} ${g.events.length}`).join(" / ") || "（空）"}`);

  writeOutput(groups, config, outputDir, minuteTag, {
    okFeeds: okFeeds.length,
    failedFeeds: failedFeeds.length,
    totalArticles: deduped.length,
    eventCount: events.length,
    maxItemsPerCategory: maxPerCategory,
  });

  store.events = {};
  for (const record of workspace.list()) store.events[record.id] = record;
  saveStore(stateDir, store, retentionDays);
  console.log(`[state] 缓存条目 ${Object.keys(store.items).length} 条、事件 ${Object.keys(store.events).length} 个（保留 ${retentionDays} 天）`);
  if (failedFeeds.length > 0) {
    console.log(`[done] 失败源 ${failedFeeds.length} 个: ${failedFeeds.map((f) => f.id).join(", ")}`);
  }
}

await main().catch((error) => {
  console.error("[fatal]", error instanceof Error ? error.message : error);
  process.exit(1);
});
