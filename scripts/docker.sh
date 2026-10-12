#!/usr/bin/env bash
# 把 news-digest 打包成 Docker 镜像（NAS 上部署用）。
#
#   ./scripts/docker.sh                                  构建，打 latest 和 <时间戳> 两个标签
#   IMAGE=192.168.10.123:5000/news-digest ./scripts/docker.sh   推到私有 registry 的名字
#   PLATFORM=linux/arm64 ./scripts/docker.sh             跨架构构建（NAS 是 ARM 而本机是 x86 时）
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：本机没有 docker，装好再跑（或在有 docker 的机器上构建后推到 registry）" >&2
  exit 1
fi

IMAGE="${IMAGE:-news-digest}"
tag="$(date +%Y-%m-%d-%H%M)"
port="$(sed -n 's/^[[:space:]]*SERVE_PORT=//p' .env 2>/dev/null | tail -1)"
port="${port:-8080}"

build=(docker build -t "$IMAGE:latest" -t "$IMAGE:$tag" .)
[[ -n "${PLATFORM:-}" ]] && build+=(--platform "$PLATFORM")

"${build[@]}"

echo
echo "== 镜像已构建 =="
docker images "$IMAGE" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' | head -5

cat <<EOF

每天凌晨自己跑一轮（推荐用这个，容器常驻、不需要在 NAS 上配计划任务）：
  docker run -d --name news-digest-schedule \\
    --env-file .env \\
    -e TZ=Asia/Shanghai \\
    -e SCHEDULE_TIME=02:00 \\
    -v $PWD/output:/app/output \\
    -v $PWD/state:/app/state \\
    --restart unless-stopped \\
    $IMAGE:latest loop

  到点它自己起一个流水线子进程跑完再睡回去；docker logs news-digest-schedule 看每轮的起止。
  TZ 必须是 Asia/Shanghai，否则容器按 UTC 计时，02:00 等于北京时间 10:00，
  而且 output/ 里带分钟的文件名会差 8 小时。写进 .env 也行，-e 的优先级更高。
  一轮跑超过 24 小时会跳过当天那一次，第二天照常。

只想手动跑一轮（跑完就退出，适合放进宿主 crontab）：
  docker run --rm \\
    --env-file .env \\
    -e TZ=Asia/Shanghai \\
    -v $PWD/output:/app/output \\
    -v $PWD/state:/app/state \\
    $IMAGE:latest digest

起常驻订阅服务（订阅地址 http://<本机IP>:${port}/feed.xml）：
  docker run -d --name news-digest \\
    --env-file .env \\
    -e TZ=Asia/Shanghai \\
    -v $PWD/output:/app/output \\
    -v $PWD/state:/app/state \\
    -p ${port}:${port} \\
    --restart unless-stopped \\
    $IMAGE:latest serve

说明：
  --env-file 读的就是项目根这个 .env（标准 KEY=VALUE，docker 和 node 都能解析）。
  容器里的 output/ 和 state/ 挂在宿主机上，所以定时器和服务可以是两个容器，
  定时器容器写完 feed.xml，服务容器下一次请求就拿到最新一份。
  挂载目录要能被 uid 1000（容器里的 node 用户）写入，NAS 上如报权限错就 chown 1000:1000。
  镜像里没有 .env，key 不会被打进层里。
  容器里的 localhost 是容器自己：.env 里那两个 proxy 指向 127.0.0.1 的话，
  抓国外源会失败，要么改成代理所在机器的局域网地址，要么加 --network=host（那样 -p 就不用写了）。
  每天多两个带分钟的文件，留够几天要清一次：
  find $PWD/output -name 'feed-2*.xml' -o -name 'digest-2*.md' | xargs -r rm -f --
EOF
