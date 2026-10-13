import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  /** AI 没给出分类时的兜底归属 */
  category?: string;
}

export interface Category {
  id: string;
  name: string;
}

/** 排序口径：来源数优先还是 AI 分数优先，第三键固定是事件内最新报道时间 */
export type SortBy = "sources" | "score";

export interface Settings {
  maxItemsPerFeed: number;
  fetchConcurrency: number;
  outputDir: string;
  stateDir: string;
  feedTitle: string;
  feedDescription: string;
  siteBaseUrl: string;
  /** 一次归并请求送多少个条目 */
  mergeBatchSize?: number;
  /** 每个类别最多输出多少条 */
  maxItemsPerCategory?: number;
  /** 摘要保留多少字 */
  summaryMaxChars?: number;
  /** 连续这么多天没在任何源架上见到的条目/事件，从缓存里清掉 */
  retentionDays?: number;
  /** 排序口径，默认 sources */
  sortBy?: SortBy;
  /** 分数达到这个值的事件必留、不占每类名额；0 = 关闭 */
  minScore?: number;
  /** 独立来源数达到这个值的事件必留、不占每类名额；0 = 关闭 */
  minSources?: number;
}

export interface Prompts {
  /** 逐条调用：中文标题 + 类别，同时充当内容风控探针 */
  item: string;
  /** 批量归并：新条目对已有事件的指派 */
  merge: string;
  /** 逐事件调用：重要度打分 */
  score: string;
}

export interface LlmSettings {
  model: string;
  temperature: number;
  concurrency?: number;
  retries?: number;
  /** 每分钟最多发多少个 AI 请求，0 表示不限 */
  rpm?: number;
  /** 混合推理模型的思考模式开关（DeepSeek V4.1 Flash 等默认开思考） */
  thinking?: "enabled" | "disabled";
  /** 是否做逐条标注（中文标题 + 类别）。0 = 关闭，直接用原文标题和源声明的类别 */
  annotate?: number;
  /** 是否逐事件打分。0 = 关闭，所有事件记 0 分 */
  score?: number;
}

export interface PagesTarget {
  apiBase: string;
  repo: string;
  branch: string;
  dir: string;
  token: string;
}

export interface Config {
  settings: Settings;
  profile: string;
  prompts: Prompts;
  llm: LlmSettings;
  sources: FeedSource[];
  categories: Category[];
  apiKey: string;
  apiBase: string;
  model: string;
  llmConcurrency: number;
  llmRetries: number;
  llmRpm: number;
  /** undefined 表示请求里不带 thinking 字段，交给服务端默认 */
  llmThinking?: "enabled" | "disabled";
  /** 逐条标注开关：false 时标题用原文、类别取源声明的 category，不发标注请求 */
  llmAnnotate: boolean;
  /** 逐事件打分开关：false 时不发打分请求，事件一律 0 分 */
  llmScore: boolean;
  /** 排序口径：sources = 来源数 → 分数 → 时间；score = 分数 → 来源数 → 时间 */
  sortBy: SortBy;
  /** 必留分数门槛（0-10，可为小数），0 = 该维度不生效 */
  minScore: number;
  /** 必留独立来源数门槛，0 = 该维度不生效 */
  minSources: number;
  /** PAGES_REPO / PAGES_DIR / PAGES_TOKEN 三者齐全才给，缺一个就是不发布 */
  pages?: PagesTarget;
  /** feed 自址（FEED_URL），channel 的 <link> / <atom:link> 与 guid 前缀都用它 */
  feedUrl?: string;
}

const REQUIRED_SETTINGS = [
  "maxItemsPerFeed",
  "fetchConcurrency",
  "outputDir",
  "stateDir",
  "feedTitle",
  "feedDescription",
  "siteBaseUrl",
] as const;

export function loadConfig(projectRoot: string): Config {
  const file = process.env.FEEDS_CONFIG ?? path.join(projectRoot, "feeds.yaml");
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const sourcesFile = path.join(path.dirname(file), "sources", "sources.yaml");

  const settings = { ...requiredSection(raw, "settings") } as Record<string, unknown>;
  for (const key of REQUIRED_SETTINGS) {
    if (settings[key] === undefined) {
      throw new Error(`feeds.yaml settings.${key} 缺失`);
    }
  }

  const profile = String(raw.profile ?? "").trim();
  const prompts = requiredSection(raw, "prompts") as unknown as Prompts;
  for (const key of ["item", "merge", "score"] as const) {
    if (!prompts[key]) {
      throw new Error(`feeds.yaml prompts.${key} 缺失`);
    }
  }

  const llm = (raw.llm ?? {}) as LlmSettings;
  const apiKey = process.env.LLM_API_KEY ?? "";
  const apiBase = (process.env.LLM_API_BASE ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || llm.model || "";
  const llmConcurrency = readPositiveInt(process.env.LLM_CONCURRENCY, llm.concurrency, 1);
  const llmRetries = readNonNegativeInt(process.env.LLM_RETRIES, llm.retries, 3);
  const llmRpm = readNonNegativeInt(process.env.LLM_RPM, llm.rpm, 0);
  const llmThinking = readThinking(process.env.LLM_THINKING, llm.thinking);
  const llmAnnotate = readNonNegativeInt(process.env.LLM_ANNOTATE, llm.annotate, 1) !== 0;
  const llmScore = readNonNegativeInt(process.env.LLM_SCORE, llm.score, 1) !== 0;
  const sortBy = readSortBy(process.env.SORT_BY, settings.sortBy as SortBy | undefined);
  const minScore = readNonNegativeNumber(process.env.MIN_SCORE, settings.minScore as number | undefined, 0);
  const minSources = readNonNegativeInt(process.env.MIN_SOURCES, settings.minSources as number | undefined, 0);
  const feedUrl = readFeedUrl(process.env.FEED_URL);
  settings.siteBaseUrl = String(settings.siteBaseUrl ?? "");
  if (!feedUrl && !settings.siteBaseUrl) {
    throw new Error(
      "FEED_URL 与 settings.siteBaseUrl 至少要有一个——RSS 2.0 的 channel <link> 是必填项，" +
        "写 file:// 会被鸿蒙的 http 模块以 2300003 拒掉",
    );
  }
  const pages = readPages();

  const sources = loadSources(sourcesFile);
  const categories = loadCategories(raw.categories);
  const categoryIds = new Set(categories.map((c) => c.id));
  for (const source of sources) {
    if (source.category && !categoryIds.has(source.category)) {
      throw new Error(`sources/sources.yaml 源 ${source.id} 的 category "${source.category}" 不在 categories 列表中`);
    }
  }

  return {
    settings: settings as unknown as Settings,
    profile,
    prompts,
    llm: { model: llm.model ?? "", temperature: llm.temperature ?? 0.2 },
    sources,
    categories,
    apiKey,
    apiBase,
    model,
    llmConcurrency,
    llmRetries,
    llmRpm,
    llmThinking,
    llmAnnotate,
    llmScore,
    sortBy,
    minScore,
    minSources,
    pages,
    feedUrl,
  };
}

function loadSources(file: string): FeedSource[] {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到订阅源文件 ${file}`);
  }
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const sources = (raw.sources as FeedSource[] | undefined) ?? [];
  if (sources.length === 0) {
    throw new Error(`${file} 未配置任何订阅源`);
  }
  return sources;
}

function loadCategories(value: unknown): Category[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("feeds.yaml 缺少非空的 categories 段");
  }

  const categories = value as Category[];
  for (const category of categories) {
    if (!category?.id || !category?.name) {
      throw new Error("feeds.yaml categories 每一项都需要 id 和 name");
    }
  }

  const ids = categories.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("feeds.yaml categories 的 id 不能重复");
  }

  return categories;
}

export function categoryIds(categories: Category[]): string[] {
  return categories.map((c) => c.id);
}

export function categoryListText(categories: Category[]): string {
  return categories.map((c) => `- ${c.id}：${c.name}`).join("\n");
}

function readPositiveInt(envValue: string | undefined, fallback: number | undefined, defaultValue: number): number {
  const parsed = envValue ? Number(envValue) : fallback;
  return Number.isInteger(parsed) && (parsed as number) >= 1 ? (parsed as number) : defaultValue;
}

function readNonNegativeInt(envValue: string | undefined, fallback: number | undefined, defaultValue: number): number {
  const parsed = envValue ? Number(envValue) : fallback;
  return Number.isInteger(parsed) && (parsed as number) >= 0 ? (parsed as number) : defaultValue;
}

/** 门槛允许小数（AI 分数是 0-10 带一位小数），非数字或负数回落默认 */
function readNonNegativeNumber(
  envValue: string | undefined,
  fallback: number | undefined,
  defaultValue: number,
): number {
  const parsed = envValue ? Number(envValue) : fallback;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

const THINKING_VALUES = ["enabled", "disabled"] as const;

/** 只接受 enabled/disabled，其它值（包括空）回落默认，不设就不发 thinking 字段 */
function readThinking(
  envValue: string | undefined,
  fallback: "enabled" | "disabled" | undefined,
): "enabled" | "disabled" | undefined {
  if (envValue) {
    const v = envValue.trim().toLowerCase();
    return (THINKING_VALUES as readonly string[]).includes(v) ? (v as "enabled" | "disabled") : fallback;
  }
  return fallback;
}

const SORT_VALUES: readonly string[] = ["sources", "score"];

/** 排序口径只认 sources/score，其它值回落 sources */
function readSortBy(envValue: string | undefined, fallback: SortBy | undefined): SortBy {
  const value = envValue ? envValue.trim().toLowerCase() : fallback;
  return SORT_VALUES.includes(value ?? "") ? (value as SortBy) : "sources";
}

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** FEED_URL 只接受 http(s)；留空返回 undefined，写了但不合法直接抛错 */
function readFeedUrl(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`FEED_URL 必须以 http:// 或 https:// 开头（收到 "${value}"）`);
  }
  return value;
}

/**
 * PAGES_REPO / PAGES_DIR / PAGES_TOKEN 三者齐才发布，缺任何一个返回 undefined。
 * 齐了以后字段不合法（发错仓库/目录级别的风险）直接抛错，不静默。
 */
function readPages(): PagesTarget | undefined {
  const repo = (process.env.PAGES_REPO ?? "").trim();
  const dir = (process.env.PAGES_DIR ?? "").trim();
  const token = (process.env.PAGES_TOKEN ?? "").trim();
  const configured = Boolean(repo && dir && token);
  console.log(`[pages] Contents 令牌${token ? "已配置" : "未配置"}`);
  if (!configured) return undefined;

  if (!OWNER_REPO.test(repo)) {
    throw new Error(`PAGES_REPO 必须形如 owner/name（收到 "${repo}"）`);
  }
  const cleanDir = dir.replace(/^\/+|\/+$/g, "");
  if (!cleanDir) {
    throw new Error(`PAGES_DIR 去掉首尾 / 后为空（收到 "${dir}"）`);
  }
  const apiBase = (process.env.PAGES_API_BASE ?? "https://api.github.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBase)) {
    throw new Error(`PAGES_API_BASE 必须以 http:// 或 https:// 开头（收到 "${apiBase}"）`);
  }
  const branch = (process.env.PAGES_BRANCH ?? "main").trim() || "main";
  return { apiBase, repo, branch, dir: cleanDir, token };
}

function requiredSection(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (!value || typeof value !== "object") {
    throw new Error(`feeds.yaml 缺少 ${key} 段`);
  }
  return value as Record<string, unknown>;
}
