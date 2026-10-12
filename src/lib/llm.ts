export interface LlmClientOptions {
  apiBase: string;
  apiKey: string;
  model: string;
  temperature: number;
  concurrency: number;
  retries: number;
  /** 每分钟最多发多少个请求，0 表示不限 */
  rpm: number;
  /** 思考模式：DeepSeek V4.1 Flash 等混合推理模型默认开思考，标注这种简单任务关掉更省更快；undefined 表示不带这个字段 */
  thinking?: "enabled" | "disabled";
}

export class LlmNotConfiguredError extends Error {}

/** 云端内容风控拦下这条请求（HTTP 400 带敏感提示，或 finish_reason=content_filter / 空响应） */
export class LlmContentFilteredError extends Error {}

const RATE_WINDOW_MS = 60_000;

export class LlmClient {
  readonly options: LlmClientOptions;
  private availableSlots: number;
  private waiters: Array<() => void> = [];
  /** 最近一分钟内的请求起始时间，用于限速 */
  private recentStarts: number[] = [];

  constructor(options: LlmClientOptions) {
    this.options = options;
    this.availableSlots = options.concurrency;
  }

  get configured(): boolean {
    return Boolean(this.options.apiKey && this.options.model);
  }

  private async acquire(): Promise<void> {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.availableSlots += 1;
    }
  }

  /** 一分钟内最多发出 rpm 个请求：窗口内已满就等最早的那个滑出去 */
  private async waitForRateBudget(): Promise<void> {
    const rpm = this.options.rpm;
    if (rpm <= 0) return;

    for (;;) {
      const now = Date.now();
      this.recentStarts = this.recentStarts.filter((start) => now - start < RATE_WINDOW_MS);
      if (this.recentStarts.length < rpm) {
        this.recentStarts.push(now);
        return;
      }
      await sleep(this.recentStarts[0] + RATE_WINDOW_MS - now);
    }
  }

  async complete(prompt: string): Promise<string> {
    if (!this.configured) {
      throw new LlmNotConfiguredError("需要设置 LLM_API_KEY 与 LLM_MODEL（LLM_API_BASE 默认 OpenAI 官方）");
    }

    const attempts = this.options.retries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt, lastError));
      }
      try {
        return await this.withSlot(() => this.requestOnce(prompt));
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break;
        console.warn(`[llm] 第 ${attempt + 1}/${attempts} 次请求失败: ${(error as Error).message}`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce(prompt: string): Promise<string> {
    const response = await fetch(`${this.options.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: this.options.temperature,
        messages: [{ role: "user", content: prompt }],
        // 混合推理模型（DeepSeek V4.1 Flash）的开关，非必填，不设就不发这个字段
        ...(this.options.thinking ? { thinking: { type: this.options.thinking } } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmHttpError(response.status, retryAfterMs(response.headers.get("retry-after")), text.slice(0, 300));
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const content = (choice?.message?.content ?? "").trim();
    if (choice?.finish_reason === "content_filter" || content === "") {
      throw new LlmContentFilteredError("响应被内容过滤（finish_reason=" + (choice?.finish_reason ?? "无") + "）");
    }
    return content;
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.waitForRateBudget();
      return await task();
    } finally {
      this.release();
    }
  }

  async completeJson<T>(prompt: string): Promise<T> {
    const text = await this.complete(prompt);
    try {
      return extractJson<T>(text);
    } catch (error) {
      const retry = await this.complete(
        `${prompt}\n\n注意：上一次你的输出无法被解析为 JSON（${(error as Error).message}）。这次只输出纯 JSON，不要任何其他文字或代码块标记。`,
      );
      return extractJson<T>(retry);
    }
  }
}

class LlmHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs: number | undefined, message: string) {
    super(`LLM API ${status}: ${message}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LlmContentFilteredError) return false;
  if (error instanceof LlmHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof Error;
}

/** 这条请求是被内容风控拦掉的（重试也没用），调用方据此丢弃对应条目 */
export function isContentFiltered(error: unknown): boolean {
  if (error instanceof LlmContentFilteredError) return true;
  if (error instanceof LlmHttpError && error.status === 400) {
    return /敏感|不安全|违规|审核|风控|content.?filter|content.?policy/i.test(error.message);
  }
  return false;
}

function backoffMs(attempt: number, lastError: unknown): number {
  if (lastError instanceof LlmHttpError && lastError.retryAfterMs !== undefined) {
    return Math.min(lastError.retryAfterMs, 60_000);
  }
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractJson<T>(text: string): T {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) {
    body = fence[1].trim();
  }

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("响应中未找到 JSON 对象");
  }

  return JSON.parse(body.slice(start, end + 1)) as T;
}
