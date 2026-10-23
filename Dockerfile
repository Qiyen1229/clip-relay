# 可選：想要「不可變映像」時使用（見 README「方式 B」）。
# 預設的 docker-compose.yml 不使用此檔，因此不需要 build。
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=9144 DATA_DIR=/data
COPY package.json supervisor.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 9144
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9144/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "supervisor.js"]
