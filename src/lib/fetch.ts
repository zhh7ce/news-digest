import Parser from "rss-parser";
import type { FeedSource, Settings } from "./config.ts";

export interface Article {
  link: string;
  title: string;
  pubDate: string;
  isoDate: string;
  description: string;
  sourceId: string;
  sourceName: string;
  sourceCategory: string;
}

export interface FetchResult {
  articles: Article[];
  okFeeds: string[];
  failedFeeds: Array<{ id: string; error: string }>;
}

// RSSHub 缓存在过期时要现场逐篇抓原文，冷启动单次响应能到十几秒
const FETCH_TIMEOUT_MS = 30_000;

const parser = new Parser<Record<string, unknown>, Record<string, unknown>>({
  timeout: FETCH_TIMEOUT_MS,
  headers: { "User-Agent": "news-digest/1.0 (RSS curator)" },
  customFields: {
    item: [["content:encoded", "contentEncoded"]],
  },
});

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : "";
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 描述是 RSS 里截来的正文开头，各家站点会把它前面的样式声明、广告占位、责编署名和
 * 版权声明一起带进来，直接当摘要会读不下去。这些片段形态固定，按模式清掉。
 */
export function cleanDescription(raw: string, maxChars: number): string {
  const text = raw
    .replace(/[\w.#>[\]-]*\{[^{}]*\}/g, " ")
    .replace(/<!?--?|-->|\]\s*article_adlist/gi, " ")
    .replace(/(?:责任编辑|特约记者|记者|编辑|作者|摄影|排版)[:：][^\s，。；;、|]{0,10}/g, " ")
    .replace(
      /(?:copyright|©|Ⓒ)\s*(?:\d{4}[-–—]?\d{0,4}\s*)?.{0,30}?(?:版权所有|保留所有权利|all rights reserved)/gi,
      " ",
    )
    .replace(/#\d{3,5};/g, "")
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

async function fetchOne(source: FeedSource, maxItems: number, summaryMaxChars: number): Promise<Article[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let xml: string;
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "news-digest/1.0 (RSS curator)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    xml = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const feed = await parser.parseString(xml);
  return (feed.items ?? [])
    .slice(0, maxItems)
    .map((item) => {
      const rawContent = asString(item.contentEncoded) || asString(item["content:encoded"]);
      const body = rawContent || asString(item.content) || asString(item.summary) || asString(item.contentSnippet);
      return {
        link: asString(item.link),
        title: stripHtml(asString(item.title)),
        pubDate: asString(item.pubDate),
        isoDate: asString(item.isoDate),
        description: cleanDescription(stripHtml(body), summaryMaxChars),
        sourceId: source.id,
        sourceName: source.name,
        sourceCategory: source.category ?? "other",
      };
    })
    .filter((a) => a.link && a.title);
}

const LINK_DATE_PATTERNS = [
  /\/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/,
  /\/(20\d{2})\/(\d{2})(\d{2})\//,
  /\/(20\d{2})(\d{2})(\d{2})/,
];

function dateFromLink(link: string): number | undefined {
  for (const pattern of LINK_DATE_PATTERNS) {
    const m = link.match(pattern);
    if (!m) continue;
    const [year, month, day] = m.slice(1, 4).map((x) => parseInt(x, 10));
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const time = Date.UTC(year, month - 1, day);
    if (!Number.isNaN(time)) return time;
  }
  return undefined;
}

/** 发布时间戳，没有日期信息的是 0（同源比较时排在最后） */
export function publishedTimeMs(article: Article): number {
  const raw = article.isoDate || article.pubDate;
  if (raw) {
    const timeMs = new Date(raw).getTime();
    if (!Number.isNaN(timeMs)) return timeMs;
  }
  return dateFromLink(article.link) ?? 0;
}

/** 全量抓取：不按时间过滤，源架上挂着多少就用多少 */
export async function fetchAllSources(sources: FeedSource[], settings: Settings): Promise<FetchResult> {
  const summaryMaxChars = settings.summaryMaxChars ?? 400;
  const articles: Article[] = [];
  const okFeeds: string[] = [];
  const failedFeeds: Array<{ id: string; error: string }> = [];

  for (let i = 0; i < sources.length; i += settings.fetchConcurrency) {
    const batch = sources.slice(i, i + settings.fetchConcurrency);
    const results = await Promise.allSettled(
      batch.map((source) => fetchOne(source, settings.maxItemsPerFeed, summaryMaxChars)),
    );

    results.forEach((result, j) => {
      const source = batch[j];
      if (result.status === "fulfilled") {
        articles.push(...result.value);
        okFeeds.push(source.id);
        const undated = result.value.filter((a) => publishedTimeMs(a) === 0).length;
        console.log(
          `[fetch] ${source.name}: ${result.value.length} 条` + (undated ? `（其中 ${undated} 条无日期）` : ""),
        );
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failedFeeds.push({ id: source.id, error });
        console.warn(`[fetch] ${source.name} 失败: ${error}`);
      }
    });
  }

  return { articles, okFeeds, failedFeeds };
}
