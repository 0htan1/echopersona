# 多阶段构建：最终镜像只带生产依赖
FROM node:22-alpine AS base
WORKDIR /app

# ---- 依赖层（利用缓存）----
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts：postinstall 会跑 scripts/build-vendor.mjs，而这一层
# 只拷了 package.json、没有 scripts/ 目录，直接跑必然 ENOENT 把构建搞挂。
# vendor 产物在运行层显式构建（见下），不依赖 npm 生命周期。
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# ---- 运行层 ----
FROM base AS runner
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

# 用非 root 用户运行
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# 把 SDK 的浏览器产物转成 ESM 放进 public/vendor。
# 必须在 COPY 之后：脚本要同时读 node_modules 和写 public/。
RUN node scripts/build-vendor.mjs

# 数据卷：数据库、上传、音频、备份、日志都落在这里
RUN mkdir -p /data && chown -R app:app /app /data
VOLUME ["/data"]

USER app
EXPOSE 8080

# 容器内健康检查（不依赖 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动前先跑迁移，再启动服务
CMD ["sh", "-c", "node --no-warnings scripts/migrate.js && node --no-warnings src/server.js"]
