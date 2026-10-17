FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/node-jobs/package.json apps/node-jobs/
COPY packages packages
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile

COPY apps/node-jobs apps/node-jobs
COPY scripts scripts
COPY deploy deploy
COPY docs docs

ENV NODE_ENV=production
