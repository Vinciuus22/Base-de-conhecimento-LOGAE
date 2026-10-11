# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Etapa 1: dependências e build (frontend + backend)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server

# ---------------------------------------------------------------------------
# Etapa 2: imagem de execução
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# ffmpeg: miniaturas de vídeo. LibreOffice (opcional, imagem maior): conversão de .doc
ARG WITH_LIBREOFFICE=false
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && if [ "$WITH_LIBREOFFICE" = "true" ]; then apt-get install -y --no-install-recommends libreoffice-writer-nogui; fi \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    SERVE_WEB=true \
    WEB_DIST_DIR=/app/web/dist \
    STORAGE_LOCAL_DIR=/data/storage
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
