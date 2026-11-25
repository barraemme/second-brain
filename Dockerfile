# Production Dockerfile for The Second Brain
FROM oven/bun:1.3.6-slim AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json publications.yaml ./
COPY migrations ./migrations
COPY evals ./evals
COPY kb ./kb

USER bun
EXPOSE 8080

CMD ["sh", "-c", "bun run migrate && bun kb/main.ts"]
