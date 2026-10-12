import * as fs from "node:fs";
import * as path from "node:path";

/** 去掉推广参数，得到跨轮次稳定的条目键 */
export function linkKey(link: string): string {
  return link
    .replace(/[?&](utm_[^=]+|source|ref)=[^&]*/gi, "")
    .replace(/[?&]$/, "")
    .replace(/#.*$/, "")
    .trim();
}

/** 标题指纹：源会把已发布的稿件改标题重发，变了就要重新标注 */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface ItemRecord {
  titleHash: string;
  /** AI 给的中文标题，归并时喂给模型的就是它 */
  titleZh: string;
  category: string;
  lastSeen: string;
  /** 这条被云端风控拦下过，存的是原标题和源声明的类别，不再重复请求 */
  filtered?: boolean;
}

export interface EventRecord {
  /** 建组时代表条目的 linkKey，跨轮次稳定 */
  id: string;
  titleZh: string;
  category: string;
  /** 成员条目的 linkKey 列表 */
  members: string[];
  score?: number;
  /** 打过分就不再重打，有这个字段即用缓存 */
  scoredAt?: string;
  lastSeen: string;
}

export interface Store {
  items: Record<string, ItemRecord>;
  events: Record<string, EventRecord>;
}

export function loadStore(stateDir: string): Store {
  fs.mkdirSync(stateDir, { recursive: true });
  const empty: Store = { items: {}, events: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "digest-state.json"), "utf8")) as Store;
    return { items: parsed.items ?? {}, events: parsed.events ?? {} };
  } catch {
    return empty;
  }
}

export function saveStore(stateDir: string, store: Store, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const fresh = (lastSeen: string) => new Date(lastSeen).getTime() >= cutoff;

  const items: Record<string, ItemRecord> = {};
  for (const [key, record] of Object.entries(store.items)) if (fresh(record.lastSeen)) items[key] = record;

  const events: Record<string, EventRecord> = {};
  for (const [key, record] of Object.entries(store.events)) {
    // 成员列表在每轮收尾时已经重写成"本轮还在架的那些"，这里只按事件自己的 lastSeen 决定去留
    if (fresh(record.lastSeen)) events[key] = record;
  }

  fs.writeFileSync(
    path.join(stateDir, "digest-state.json"),
    JSON.stringify({ items, events }, null, 2),
    "utf8",
  );
}
