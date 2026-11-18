FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .

# Switch to --frozen-lockfile once pnpm-lock.yaml is committed.
RUN pnpm install
RUN pnpm --filter @mrm/web build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# The server runs TypeScript directly (Node type stripping). See docs/spikes/sidecar.md.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
