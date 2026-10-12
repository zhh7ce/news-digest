#!/bin/sh
# 镜像入口：第一个参数决定干什么，其余交给 node
# digest = 跑一轮流水线后退出，serve = 起 HTTP 订阅服务常驻，其它 = 当作命令直接执行
set -e

cd /app

case "${1:-digest}" in
  digest) exec node --env-file-if-exists=.env src/digest.ts ;;
  serve) exec node --env-file-if-exists=.env src/serve.ts ;;
  *) exec "$@" ;;
esac
