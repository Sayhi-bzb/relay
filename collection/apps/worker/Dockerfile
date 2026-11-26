FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
# better-sqlite3 may compile from source when a matching prebuild is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter @aidt/worker...
COPY apps/worker apps/worker
WORKDIR /app/apps/worker
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]
CMD ["run"]
