import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 容器常驻定时器：每天到点跑一轮流水线，省掉在 NAS 上配计划任务。
 * 流水线本身是一次性子进程，跑完退出，这里只负责掐表和重启。
 * 本地时区跟着 TZ 走，容器里不带 TZ 就是 UTC，02:00 会跑在北京时间 10:00。
 */

const DEFAULT_TIME = "02:00";
/** 一次最多睡这么久就重新查表，系统休眠或时钟被改过都不会睡过头 */
const MAX_SLEEP = 10 * 60_000;
const projectRoot = path.resolve(import.meta.dirname, "..");

type TimeOfDay = { hour: number; minute: number };

function parseTime(raw: string | undefined): TimeOfDay | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** 从 from 起算的下一个 HH:MM，本地时区（跟着 TZ 环境变量走）；今天这个点已经过了就排到明天 */
function nextRun(at: TimeOfDay, from: Date): Date {
  const next = new Date(from);
  next.setHours(at.hour, at.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function stamp(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function remaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(minutes / 60)} 小时 ${pad2(minutes % 60)} 分`;
}

function log(message: string): void {
  console.log(`[schedule] ${message}`);
}

let current: ChildProcess | undefined;
let wake: (() => void) | undefined;
let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, Math.min(ms, MAX_SLEEP));
    wake = finish;
  });
}

function runOnce(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", path.join("src", "digest.ts"), ...args],
      { cwd: projectRoot, stdio: "inherit" },
    );
    current = child;
    child.on("error", (error) => {
      log(`起不来：${error.message}`);
      current = undefined;
      resolve();
    });
    child.on("close", (code) => {
      log(`这一轮结束，退出码 ${code}，用时 ${remaining(Date.now() - startedAt)}`);
      current = undefined;
      resolve();
    });
  });
}

function stop(signal: string): void {
  stopping = true;
  log(`收到 ${signal}，${current ? "先终止正在跑的这一轮" : "退出"}`);
  current?.kill("SIGTERM");
  wake?.();
}

export async function startScheduler(): Promise<void> {
  const args = process.argv.slice(2);
  const configured = parseTime(process.env.SCHEDULE_TIME);
  if (!configured && process.env.SCHEDULE_TIME) {
    log(`SCHEDULE_TIME="${process.env.SCHEDULE_TIME}" 不是 HH:MM，用默认 ${DEFAULT_TIME}`);
  }
  const at = configured ?? parseTime(DEFAULT_TIME) ?? { hour: 2, minute: 0 };
  const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  log(`每天 ${pad2(at.hour)}:${pad2(at.minute)}（${zone}）跑一轮${args.length ? `，附加参数：${args.join(" ")}` : ""}`);

  while (!stopping) {
    const next = nextRun(at, new Date());
    log(`下一轮 ${stamp(next)}，还有 ${remaining(next.getTime() - Date.now())}`);
    while (!stopping && next.getTime() > Date.now()) await sleep(next.getTime() - Date.now());
    if (stopping) break;
    log(`开始 ${stamp(new Date())} 这一轮`);
    await runOnce(args);
  }
  log("已退出");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => stop(signal));
}

// 直接 node src/schedule.ts 时才自跑；被 main.ts import 时只导出函数、由它来 await
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await startScheduler();
