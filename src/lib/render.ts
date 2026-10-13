import type { Category } from "./config.ts";
import type { Article } from "./fetch.ts";

export interface DigestEvent {
  category: string;
  /** 代表条目的原标题 */
  title: string;
  /** 代表条目的原摘要（已清理过页面垃圾） */
  summary: string;
  /** AI 打分，只用于排序和每类截断 */
  score: number;
  /** 独立来源数，排序第一依据 */
  sources: number;
  /** 代表条目排第一，其余按源优先级 + 时间 */
  articles: Article[];
}

export interface EventGroup {
  id: string;
  name: string;
  events: DigestEvent[];
}

export interface FeedMeta {
  title: string;
  description: string;
  selfUrl: string;
  buildDate: Date;
}

/** 按 feeds.yaml 里 categories 的声明顺序分组，配置外的类别排在最后 */
export function groupByCategory(events: DigestEvent[], categories: Category[]): EventGroup[] {
  const buckets = new Map<string, DigestEvent[]>();
  for (const event of events) {
    const bucket = buckets.get(event.category);
    if (bucket) bucket.push(event);
    else buckets.set(event.category, [event]);
  }

  const groups: EventGroup[] = [];
  for (const category of categories) {
    const bucket = buckets.get(category.id);
    if (bucket) {
      groups.push({ id: category.id, name: category.name, events: bucket });
      buckets.delete(category.id);
    }
  }
  for (const [id, bucket] of buckets) {
    groups.push({ id, name: id, events: bucket });
  }
  return groups;
}

/** 整体 feed 的文件名，板块 feed 的自址从它推出来 */
const FEED_FILE = "feed.xml";

/** 板块单独成 feed：自址沿用整体 feed 所在目录只换文件名，标题带上板块名 */
export function categoryFeedMeta(meta: FeedMeta, category: Category, fileName: string): FeedMeta {
  const dir = meta.selfUrl.endsWith(`/${FEED_FILE}`)
    ? meta.selfUrl.slice(0, -FEED_FILE.length)
    : `${meta.selfUrl.replace(/\/+$/, "")}/`;
  return {
    title: `${meta.title} · ${category.name}`,
    description: meta.description,
    selfUrl: `${dir}${fileName}`,
    buildDate: meta.buildDate,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function latestPubDate(articles: Article[]): Date {
  let best = 0;
  for (const article of articles) {
    const raw = article.isoDate || article.pubDate;
    if (!raw) continue;
    const timeMs = new Date(raw).getTime();
    if (!Number.isNaN(timeMs) && timeMs > best) best = timeMs;
  }
  return best > 0 ? new Date(best) : new Date();
}

/** 配了 siteBaseUrl（比如自建 RSSHub 的 /go 转发）就走前缀，否则直发原链接 */
function articleHref(link: string, baseUrl: string): string {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/go/${encodeURIComponent(link)}` : link;
}

function eventHtml(event: DigestEvent, baseUrl: string): string {
  const links = event.articles
    .map(
      (a) =>
        `<li><a href="${escapeXml(articleHref(a.link, baseUrl))}">${escapeXml(a.sourceName)}</a> — ${escapeXml(a.title)}</li>`,
    )
    .join("\n");

  return [
    `<p>${escapeXml(event.summary)}</p>`,
    `<p><b>${event.sources} 家媒体报道 · 重要度 ${event.score.toFixed(1)}/10</b></p>`,
    `<p><b>来源：</b></p>`,
    `<ul>\n${links}\n</ul>`,
  ].join("\n");
}

export function renderRss(groups: EventGroup[], meta: FeedMeta, baseUrl: string): string {
  const items = groups
    .flatMap((group) =>
      group.events.map((event) => {
        const primary = event.articles[0];
        const guid = `${meta.selfUrl}#${encodeURIComponent(primary.link)}`;
        return [
          "    <item>",
          `      <title>${escapeXml(event.title)}</title>`,
          `      <link>${escapeXml(primary.link)}</link>`,
          `      <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
          `      <category>${escapeXml(group.name)}</category>`,
          `      <pubDate>${latestPubDate(event.articles).toUTCString()}</pubDate>`,
          `      <description><![CDATA[${eventHtml(event, baseUrl)}]]></description>`,
          "    </item>",
        ].join("\n");
      }),
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(meta.title)}</title>
    <link>${escapeXml(meta.selfUrl)}</link>
    <description>${escapeXml(meta.description)}</description>
    <language>zh-cn</language>
    <lastBuildDate>${meta.buildDate.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(meta.selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/** 表头里每类上限的补充说明：有必留门槛时才提，否则原样 */
function capNote(minScore: number, minSources: number): string {
  const parts: string[] = [];
  if (minScore > 0) parts.push(`分数 ≥ ${minScore}`);
  if (minSources > 0) parts.push(`来源数 ≥ ${minSources}`);
  return parts.length === 0 ? "" : `，${parts.join(" 或 ")} 的必留不占名额`;
}

export interface RenderStats {
  okFeeds: number;
  failedFeeds: number;
  totalArticles: number;
  eventCount: number;
  maxItemsPerCategory: number;
  /** 必留门槛，0 = 该维度不生效；都为 0 时表头不提必留 */
  minScore?: number;
  minSources?: number;
}

/** Markdown 和 HTML 共用的那两行统计 */
function summaryLines(groups: EventGroup[], stats: RenderStats, totalEvents: number): string[] {
  const cap = `每类上限 ${stats.maxItemsPerCategory}${capNote(stats.minScore ?? 0, stats.minSources ?? 0)}`;
  return [
    `${stats.okFeeds}/${stats.okFeeds + stats.failedFeeds} 源 · 在架 ${stats.totalArticles} 条 → ${stats.eventCount} 个事件 → 输出 ${totalEvents} 条（${cap}）`,
    groups.map((group) => `${group.name} ${group.events.length}`).join(" · "),
  ];
}

export function renderMarkdown(
  groups: EventGroup[],
  meta: FeedMeta,
  stats: RenderStats,
): string {
  const totalEvents = groups.reduce((sum, group) => sum + group.events.length, 0);
  const lines: string[] = [];
  lines.push(`# ${meta.title} — ${meta.buildDate.toISOString().slice(0, 10)}`);
  lines.push("");
  for (const line of summaryLines(groups, stats, totalEvents)) {
    lines.push(`> ${line}`);
  }
  lines.push("");

  for (const group of groups) {
    lines.push(`## ${group.name}`);
    lines.push("");
    for (const [i, event] of group.events.entries()) {
      lines.push(`### ${i + 1}. ${event.title}`);
      lines.push("");
      lines.push(event.summary || "（该源没有给出摘要）");
      lines.push("");
      lines.push(`${event.sources} 家媒体报道 · 重要度 ${event.score.toFixed(1)}/10`);
      lines.push("");
      for (const article of event.articles) {
        lines.push(`- [${article.sourceName}](${article.link}) — ${article.title}`);
      }
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
