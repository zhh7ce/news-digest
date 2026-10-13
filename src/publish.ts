import * as path from "node:path";
import { loadConfig } from "./lib/config.ts";
import { publishOutput } from "./lib/pages.ts";

/**
 * 单独补发：流水线早跑过了、现在只想把 output/ 里的 feed.xml 与 digest.md 推上 Pages。
 * 与 digest.ts、serve.ts 同级；容器里对应 docker-entrypoint.sh 的 publish 模式。
 */
const projectRoot = path.resolve(import.meta.dirname, "..");
await publishOutput(loadConfig(projectRoot), projectRoot);
