# syntax=docker/dockerfile:1
#
# Build context is the repository root:
#   docker build -f apps/frontend/Dockerfile -t agent-board-web .

# The Caddy that serves the app and proxies the backend, pinned by version and digest: the Caddyfile's guarantees rest on
# Caddy's semantics (`header_down -*`, the deferred `>` headers), so a new release is a change to review. The CI job pulls
# this image and src/caddyfile.docker.test.ts runs the Caddyfile in it, both reading this line, so keep it on one line.
ARG CADDY_IMAGE=caddy:2.11.9@sha256:f971688b2aaf1a26d256de552f17fb13f64fc5ed2dee4cf40c7f9d70cea0e12d

########################################
# Builder
########################################
FROM node:24-bookworm-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.28.9 --activate
WORKDIR /app

# The frontend type-imports the backend's tRPC router, so the backend's sources and
# dependencies are needed for `tsc` (not at runtime).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @agent-board/frontend...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend/src apps/backend/src
COPY apps/frontend apps/frontend
RUN pnpm --filter @agent-board/frontend build

########################################
# Runtime: static SPA + reverse proxy to the backend service
########################################
FROM ${CADDY_IMAGE} AS runtime
COPY --from=builder /app/apps/frontend/dist /srv
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
