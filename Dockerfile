# PlantOmics Hub —— 服务端镜像草案（未构建、未验证）
#
# 目的：把「薄插件 + 远程 MCP 服务」里的**服务**跑成常驻容器，为将来上云做准备。
# 当前状态：本机没有 Docker，构建与运行均未验证，不能当已可用交付。
#
# 构建：  docker build -t plantomics-hub:0.1.0 .
# 运行：  docker run --rm -p 8787:8787 -e PLANTOMICS_HUB_HOST=0.0.0.0 -e PLANTOMICS_HUB_TOKEN=<至少16字符> plantomics-hub:0.1.0
#
# 注意：
#   - 容器内必须绑 0.0.0.0，否则宿主机映射不到端口；绑非回环时配置层强制要求 token。
#   - 反向代理/平台域名要进 PLANTOMICS_HUB_ALLOWED_HOSTS，否则 Host 校验会 403。
#   - 本服务无状态（每条请求独立 server+transport），可水平扩容，不需要会话亲和。
#   - 健康检查待服务补 /healthz 后再加 HEALTHCHECK；现在加会因 404 被误判不健康。

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY cordis.patch.yml README.md LICENSE ./
ENV PLANTOMICS_HUB_HOST=0.0.0.0
ENV PLANTOMICS_HUB_PORT=8787
EXPOSE 8787
USER node
CMD ["node", "dist/service/cli.js"]
