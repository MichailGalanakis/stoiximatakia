# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY engines/xeri ./engines/xeri
COPY engines/diloti ./engines/diloti
COPY engines/rummy ./engines/rummy
COPY engines/tichu ./engines/tichu
COPY engines/chess ./engines/chess
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/engines/xeri/dist/cjs ./engines/xeri/dist/cjs
COPY --from=build --chown=node:node /app/engines/diloti/dist/cjs ./engines/diloti/dist/cjs
COPY --from=build --chown=node:node /app/engines/rummy/dist/cjs ./engines/rummy/dist/cjs
COPY --from=build --chown=node:node /app/engines/tichu/dist/cjs ./engines/tichu/dist/cjs
COPY --from=build --chown=node:node /app/engines/chess/dist/cjs ./engines/chess/dist/cjs
COPY --chown=node:node scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=node:node deploy/migrate-production.mjs ./scripts/migrate-production.mjs
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
