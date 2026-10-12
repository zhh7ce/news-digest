import { publishedTimeMs, type Article } from "./fetch.ts";

/** feeds.yaml 里 sources: 的声明顺序，越小越优先；配置外的源排在最后 */
export function rankOf(sourceOrder: Map<string, number>, article: Article): number {
  return sourceOrder.get(article.sourceId) ?? Number.POSITIVE_INFINITY;
}

/**
 * 一条新闻的标题、摘要和主链接都取自这一条：优先级最高的源里发布时间最新的那条。
 * 完全由配置决定，不看 AI。
 */
export function pickRepresentative(
  articles: Article[],
  sourceOrder: Map<string, number>,
): Article {
  return articles
    .slice()
    .sort((a, b) => rankOf(sourceOrder, a) - rankOf(sourceOrder, b) || publishedTimeMs(b) - publishedTimeMs(a))[0];
}

/** 板块由组内各条报道的 AI 类别投票决定，平票时跟随代表条目 */
export function voteCategory(
  articles: Article[],
  categoryOf: (article: Article) => string,
  sourceOrder: Map<string, number>,
): string {
  const counts = new Map<string, number>();
  for (const article of articles) {
    const category = categoryOf(article);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  let best: string | undefined;
  for (const [category, count] of counts) {
    if (!best || count > (counts.get(best) ?? 0)) best = category;
  }

  return best ?? categoryOf(pickRepresentative(articles, sourceOrder));
}

/** 独立来源数：排序第一依据 */
export function sourceCount(articles: Article[]): number {
  return new Set(articles.map((a) => a.sourceId)).size;
}
