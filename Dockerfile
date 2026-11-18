FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
COPY . .

# pnpm-lock.yaml is committed: install exactly what it says, or fail.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mrm/web build

ENV NODE_ENV=production
ENV PORT=8787
# The server writes only here (SQLite file, uploads). It is owned by the unprivileged user below;
# a named volume mounted at /data starts with this ownership.
ENV MRM_DATA_DIR=/data
ENV DATABASE_URL=file:/data/mrm.db
RUN mkdir -p /data && chown node:node /data
EXPOSE 8787

# Do not run as root. The code under /app is only read.
USER node

# The server runs TypeScript directly (Node type stripping). See docs/spikes/sidecar.md.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
