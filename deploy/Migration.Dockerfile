# A separate, one-shot migration tool. Never run migrations from API startup.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
WORKDIR /migration
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.ts ./
# Resolve the pinned engine during build, not on the internal database network.
RUN DATABASE_URL=postgresql://test_build:test_build@127.0.0.1:6543/test_build node node_modules/prisma/build/index.js --version
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
