# One-shot legacy cutover image. It contains the migration engine plus the
# reviewed attachment promotion workers and their compiled dependencies.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /migration
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm run backend:build
RUN DATABASE_URL=postgresql://test_build:test_build@127.0.0.1:6543/test_build node node_modules/prisma/build/index.js --version
USER node
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
