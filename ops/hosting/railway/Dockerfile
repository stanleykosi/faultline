# Unbuilt recipe. Operator must supply an approved immutable Node24 Linux base digest.
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS volume-init
WORKDIR /opt/faultline-volume-init
COPY --chown=root:root scripts/initialize-private-volume.mjs ./initialize-private-volume.mjs
USER root:root
ENTRYPOINT ["node","/opt/faultline-volume-init/initialize-private-volume.mjs"]
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod
FROM ${NODE_BASE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production MODEL_PROVIDER=none RUNNER_MODE=disabled ALLOW_FIXTURE_ADAPTERS=false OBJECT_STORE_PATH=/data/objects
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/api.routes.json ./api.routes.json
COPY --from=build --chown=node:node /app/contracts ./contracts
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/web ./dist/web
COPY --from=build --chown=node:node /app/packages/database/migrations ./packages/database/migrations
COPY --from=build --chown=node:node /app/scripts/hosted-supervisor.mjs ./scripts/hosted-supervisor.mjs
COPY --from=build --chown=node:node /app/scripts/hosted-private-runtime.mjs ./scripts/hosted-private-runtime.mjs
COPY --from=build --chown=node:node /app/scripts/start-hosted.mjs ./scripts/start-hosted.mjs
COPY --from=build --chown=node:node /app/fixtures/checkout-site ./fixtures/checkout-site
RUN test "$(id -u node)" = "1000" && test "$(id -g node)" = "1000" && mkdir -p /data/objects /data/keys && chown node:node /data/objects /data/keys && chmod 0700 /data/objects /data/keys
USER node:node
FROM runtime AS api
ENV PROCESS_ROLE=api
EXPOSE 3000
CMD ["node","--max-old-space-size=128","dist/server/apps/api/src/main.js"]
FROM runtime AS worker
ENV PROCESS_ROLE=worker
CMD ["node","--max-old-space-size=128","dist/server/apps/worker/src/main.js"]
FROM runtime AS operator
USER root
RUN mkdir -p /app/reports/application && chown node:node /app/reports /app/reports/application
USER node:node
ENTRYPOINT ["node"]
CMD ["--help"]
FROM runtime AS hosted
EXPOSE 3000
CMD ["node","scripts/start-hosted.mjs"]
