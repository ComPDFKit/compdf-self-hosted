FROM node:24-bookworm-slim AS development
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci
EXPOSE 8080
CMD ["npm", "run", "start:dev"]

FROM node:24-bookworm-slim AS compdf-web-build
WORKDIR /build/frontend/compdf-web
ARG VITE_HIDDEN_TOOL_SLUGS=""
ENV VITE_HIDDEN_TOOL_SLUGS=${VITE_HIDDEN_TOOL_SLUGS}
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
RUN npm prune --omit=dev \
    && find dist -type f \( -name "*.spec.js" -o -name "*.spec.js.map" -o -name "*.spec.d.ts" \) -delete

FROM node:24-bookworm-slim AS production
WORKDIR /app

ARG COMPDF_VERSION=1.1.0

ENV NODE_ENV=production \
    PORT=8080 \
    COMPDF_VERSION=${COMPDF_VERSION} \
    PUBLIC_DIR=/app/public \
    LICENSE_TOKEN_PATH=/app/configs/license.jwt \
    INIT_SQL_PATH=/app/release/init.sql \
    MIGRATIONS_PATH=/app/release/migrations \
    SETTINGS_PATH=/app/configs/settings.yml \
    STORAGE_DIR=/app/storage

COPY --from=server-build /build/server/package*.json ./
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=compdf-web-build /build/frontend/compdf-web/dist ./public/compdf-web
COPY configs/init.sql ./release/init.sql
COPY migrations ./release/migrations
COPY release/version.json ./release/version.json
COPY deployment ./deployment
COPY configs/settings.yml ./configs/settings.yml

RUN touch /app/configs/license.jwt \
    && mkdir -p /app/storage && ln -s /app/configs /configs \
    && printf '#!/bin/sh\nexec node /app/dist/src/scripts/reset-password.js "$@"\n' > /usr/local/bin/reset:password \
    && chmod +x /usr/local/bin/reset:password

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v1/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
