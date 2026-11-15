# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/backend/Dockerfile -t agent-board-backend .

########################################
# Builder: full install, bundle with esbuild (inlines @agent-board/shared)
########################################
FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.28.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @agent-board/backend...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @agent-board/backend build

########################################
# Production dependencies only (pg, fastify, …)
########################################
FROM node:24-bookworm-slim AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.28.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod --filter @agent-board/backend...

########################################
# Runtime
########################################
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production

# The newest CLI release (apps/cli/package.json), which the machine API advertises; CI passes it, empty means unknown.
ARG CLI_VERSION=
ENV CLI_VERSION=$CLI_VERSION

# Non-root. All state is in Postgres.
RUN groupadd --system --gid 1001 board \
    && useradd --system --uid 1001 --gid board --home-dir /home/board --create-home board

WORKDIR /app
COPY --from=deps --chown=board:board /app ./
COPY --from=builder --chown=board:board /app/apps/backend/dist apps/backend/dist
COPY --chown=board:board apps/backend/drizzle apps/backend/drizzle

WORKDIR /app/apps/backend
USER board
EXPOSE 4000

# Migrations run on startup (src/index.ts) before the server listens.
CMD ["node", "--enable-source-maps", "dist/index.js"]
