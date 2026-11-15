# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
# tesseract.js (WASM) и русская модель не лежат в git — их тянет скрипт. curl нужен
# только на этапе сборки образа, в runtime-слое его нет.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- build (typescript -> js) ----
FROM base AS build
COPY package.json package-lock.json* ./
# NODE_ENV=production (inherited from base) skips devDependencies — override it
# so tsc and other build tools are available.
RUN NODE_ENV=development npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts/fetch-ocr-assets.sh ./scripts/fetch-ocr-assets.sh
COPY drizzle.config.ts ./
# Распознавание скриншотов: ~11 МБ ассетов в public/vendor/ocr (ядро + модель).
RUN bash scripts/fetch-ocr-assets.sh
RUN npm run build

# ---- runtime ----
FROM base AS runtime
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# src/admin is static HTML, src/scripts are script templates — copied as they are
COPY src/admin ./dist/admin
COPY src/scripts ./dist/scripts
COPY package.json ./
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

# Default command is the web server; the worker overrides command in compose.
EXPOSE 3000
CMD ["node", "dist/db/server.js"]
