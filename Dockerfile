# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---- build (typescript -> js) ----
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY drizzle.config.ts ./
RUN npm run build

# ---- runtime ----
FROM base AS runtime
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
COPY drizzle ./drizzle
COPY drizzle.config.ts ./

# Default command is the web server; the worker overrides command in compose.
EXPOSE 3000
CMD ["node", "dist/db/server.js"]
