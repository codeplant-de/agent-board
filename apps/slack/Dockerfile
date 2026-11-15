# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/slack/Dockerfile -t agent-board-slack .

########################################
# Builder: full install, bundle with esbuild (inlines @agent-board/shared)
########################################
FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.28.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/slack/package.json apps/slack/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @agent-board/slack...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/slack apps/slack
RUN pnpm --filter @agent-board/slack build

########################################
# Production dependencies only (@slack/socket-mode)
########################################
FROM node:24-bookworm-slim AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.28.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/slack/package.json apps/slack/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod --filter @agent-board/slack...

########################################
# Runtime
########################################
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production

# Non-root. It holds no state and listens on no port: it connects out to Slack and to the backend.
RUN groupadd --system --gid 1001 board \
    && useradd --system --uid 1001 --gid board --home-dir /home/board --create-home board

WORKDIR /app
COPY --from=deps --chown=board:board /app ./
COPY --from=builder --chown=board:board /app/apps/slack/dist apps/slack/dist

WORKDIR /app/apps/slack
USER board

CMD ["node", "--enable-source-maps", "dist/index.js"]
