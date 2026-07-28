# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- all dependencies (shared by build and production pruning) ----
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- build (typescript -> js) ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies ----
FROM deps AS production-deps
RUN npm prune --omit=dev

# ---- runtime ----
FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
# src/admin is static HTML — copy directly from context, no build step needed
COPY src/admin ./dist/admin
COPY package.json ./
COPY drizzle ./drizzle

# Default command is the web server; the worker overrides command in compose.
USER node
EXPOSE 3000
CMD ["node", "dist/db/server.js"]
