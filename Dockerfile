FROM node:24-bookworm-slim AS development
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
EXPOSE 8080
CMD ["npm", "run", "start:dev"]

FROM node:24-bookworm-slim AS compdf-server-build
WORKDIR /build/frontend/compdf-web
COPY frontend/compdf-web/package*.json ./
RUN npm ci
COPY frontend/compdf-web ./
RUN npm run build

FROM node:24-bookworm-slim AS server-build
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci
COPY server ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS production
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app/public \
    LICENSE_TOKEN_PATH=/app/configs/license.jwt \
    INIT_SQL_PATH=/app/configs/init.sql \
    SETTINGS_PATH=/app/configs/settings.yml \
    STORAGE_DIR=/app/storage

COPY --from=server-build /build/server/package*.json ./
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=compdf-server-build /build/frontend/compdf-web/dist ./public/compdf-web
COPY configs ./configs

RUN mkdir -p /app/storage && ln -s /app/configs /configs

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v1/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
