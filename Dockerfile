# Pin the reviewed Node image digest before a release. No credentials are build arguments.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm contracts:generate && node node_modules/typescript/bin/tsc && CI=true pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production OBJECT_STORE=supabase RUNNER_MODE=disabled ALLOW_FIXTURE_ADAPTERS=false
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/api.routes.json ./api.routes.json
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/contracts ./contracts
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node:node
CMD ["node", "scripts/start-vercel-worker.mjs"]
