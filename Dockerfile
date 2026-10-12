# news-digest 运行镜像：只装生产依赖，代码和数据目录分离
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先只装依赖，改代码不会让这一层重新构建
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY feeds.yaml ./
COPY src ./src
COPY scripts/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# output/ 和 state/ 用宿主机的目录挂进来；node 用户是 uid 1000，挂载点要能对它写
RUN mkdir -p output state && chown -R node:node /app
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
# digest = 跑一轮流水线后退出；serve = 起 HTTP 订阅服务
CMD ["digest"]
