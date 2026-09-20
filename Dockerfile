# syntax=docker/dockerfile:1.7

# Keep the patch tag explicit. Production release tooling can pass a resolved
# digest through NODE_IMAGE and should record it alongside the Git SHA.
ARG NODE_IMAGE=node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

FROM ${NODE_IMAGE} AS build

ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.revision="${BUILD_REVISION}"

ENV CI=true
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.backend.json ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma

RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm run backend:build

# The final image contains only runtime dependencies. Build tooling stays in
# this stage and is never copied into the runtime image.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime

ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.revision="${BUILD_REVISION}"

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    BUILD_REVISION=${BUILD_REVISION}
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

COPY --from=build /app/packages/adapters/package.json ./packages/adapters/package.json
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/dist ./packages/domain/dist

USER node
EXPOSE 3080

ENTRYPOINT ["node", "apps/api/dist/server.js"]
