import { startServe } from "./serve.ts";
import { startScheduler } from "./schedule.ts";

/**
 * 单容器入口：同一进程里既起只读 HTTP 服务，又跑每天定时器。
 * startScheduler 只在收到 SIGTERM/SIGINT 收尾后才返回，那时再关掉 HTTP，进程随之退出；
 * 正常运行期间它一直不返回，容器就常驻在这里对外发 feed。
 */
const server = startServe();
await startScheduler();
server.close();
server.closeAllConnections?.();
