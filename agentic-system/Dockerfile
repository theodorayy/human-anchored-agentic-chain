FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install -g pnpm@10.28.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm exec playwright install --with-deps chromium
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm build
RUN chmod +x scripts/container-start.sh && chown node:node /app && chown -R node:node /app/.eve /app/.next
ENV NODE_ENV=production
ENV HAC_DATA_DIR=/data/hac
EXPOSE 3003
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/scripts/container-start.sh"]
