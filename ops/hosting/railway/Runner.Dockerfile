# Faultline provider-neutral external-runner controller. The browser itself
# runs only inside a disposable hardened VM supplied by the selected adapter;
# this service never receives a Docker socket or executes target code here.
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM ${NODE_BASE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production PROCESS_ROLE=external-runner RUNNER_MODE=external ALLOW_FIXTURE_ADAPTERS=false PORT=3000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/contracts ./contracts
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/runner ./dist/runner
USER node:node
EXPOSE 3000
CMD ["node","--max-old-space-size=128","dist/server/apps/runner/src/external-main.js"]
