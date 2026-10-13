#!/bin/sh
# 镜像入口：第一个参数决定干什么，其余参数转给对应的脚本
# up = 单容器常驻：同一进程里既发 HTTP feed 又跑每天定时器（推荐，compose 用这个）
# digest = 跑一轮流水线后退出，serve = 只起 HTTP 订阅服务，
# loop = 只跑常驻定时器，每天 SCHEDULE_TIME（默认 02:00）自己跑一轮，其它 = 当作命令直接执行
set -e

cd /app

mode="${1:-up}"
if [ $# -gt 0 ]; then shift; fi

# ${@:2} 那种切片写法是 bash 扩展，alpine 的 ash 不认，所以先 shift 再用 "$@"
case "$mode" in
  up) exec node --env-file-if-exists=.env src/main.ts "$@" ;;
  digest) exec node --env-file-if-exists=.env src/digest.ts "$@" ;;
  serve) exec node --env-file-if-exists=.env src/serve.ts ;;
  loop) exec node --env-file-if-exists=.env src/schedule.ts "$@" ;;
  *) exec "$mode" "$@" ;;
esac
