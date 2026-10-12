import { extractJson } from "./llm.ts";

export interface MergeItem {
  /** 真实键：第一轮是条目的 linkKey，二次归并时是事件 id */
  key: string;
  title: string;
  sourceName: string;
}

export interface MergeAnchor {
  key: string;
  title: string;
}

/** prompt 里用的短编号 + 真实键 */
export interface MergeRow {
  id: string;
  key: string;
  text: string;
}

export type Assign = { kind: "anchor"; key: string } | { kind: "new"; label: string };

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

export function buildItemRows(items: MergeItem[], startAt: number): MergeRow[] {
  return items.map((item, i) => ({
    id: String(startAt + i),
    key: item.key,
    text: `[${item.sourceName}] ${item.title}`,
  }));
}

export function buildAnchorRows(anchors: MergeAnchor[]): MergeRow[] {
  return anchors.map((anchor, i) => ({ id: `a${i + 1}`, key: anchor.key, text: anchor.title }));
}

export function renderAnchors(rows: MergeRow[]): string {
  if (rows.length === 0) return "（没有已有事件，全部条目都要自己成新事件或互相合并）";
  return rows.map((row) => `- ${row.id}：${row.text}`).join("\n");
}

export function renderItems(rows: MergeRow[]): string {
  return rows.map((row) => `#${row.id} ${row.text}`).join("\n");
}

/**
 * 解析指派结果并做严格校验，不合规矩的输出都退回"自成一组"，不重问模型：
 *   item 不在本批条目里 → 忽略
 *   同一条目出现两次     → 以第一次为准
 *   event 是锚点编号     → 并入那个已有事件
 *   event 是 n- 开头     → 按标签新建/合并
 *   其它（乱写、漏掉）   → 自成一组
 */
export function parseAssignments(
  raw: string,
  opts: { items: MergeRow[]; anchors: MergeRow[] },
): Map<string, Assign> {
  const itemByKey = new Map(opts.items.map((row) => [row.id, row.key]));
  const anchorByKey = new Map(opts.anchors.map((row) => [row.id, row.key]));
  const itemIds = new Set(itemByKey.keys());
  const result = new Map<string, Assign>();

  let parsed: { assignments?: unknown };
  try {
    parsed = extractJson<{ assignments?: unknown }>(raw);
  } catch {
    parsed = {};
  }

  const list = Array.isArray(parsed.assignments) ? (parsed.assignments as Array<Record<string, unknown>>) : [];
  for (const entry of list) {
    // 编号有时被模型回成数字（"item": 61），统一按字符串处理
    const item = entry?.item === undefined ? "" : String(entry.item).trim().replace(/^#/, "");
    const event = entry?.event === undefined ? "" : String(entry.event).trim();
    const key = itemByKey.get(item);
    if (key === undefined || result.has(key)) continue;

    const anchor = anchorByKey.get(event);
    if (anchor !== undefined) result.set(key, { kind: "anchor", key: anchor });
    else if (/^n-\S+$/.test(event)) result.set(key, { kind: "new", label: event });
    else if (itemByKey.has(event)) result.set(key, { kind: "new", label: `n-${event}` });
  }

  for (const row of opts.items) {
    if (!result.has(row.key)) result.set(row.key, { kind: "new", label: `n-${row.id}` });
  }
  return result;
}

/** 把指派结果拆成"并入哪个锚点"和"哪些条目自成新组" */
export function bucketAssignments(
  assignments: Map<string, Assign>,
  keys: string[],
): { toAnchor: { anchorKey: string; key: string }[]; newGroups: Map<string, string[]> } {
  const toAnchor: { anchorKey: string; key: string }[] = [];
  const newGroups = new Map<string, string[]>();

  for (const key of keys) {
    const assign = assignments.get(key);
    if (!assign) continue;
    if (assign.kind === "anchor") {
      if (assign.key !== key) toAnchor.push({ anchorKey: assign.key, key });
      continue;
    }
    const bucket = newGroups.get(assign.label);
    if (bucket) bucket.push(key);
    else newGroups.set(assign.label, [key]);
  }
  return { toAnchor, newGroups };
}

/** 打分输出校验：分数压到 0-10，非法或缺失返回 undefined 让调用方走兜底 */
export function parseScore(raw: string): number | undefined {
  let parsed: { score?: unknown };
  try {
    parsed = extractJson<{ score?: unknown }>(raw);
  } catch {
    return undefined;
  }
  const value = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(10, value));
}
