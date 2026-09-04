# Multi-stage: the runtime image carries no compiler, no sources and no dev dependencies.
FROM node:20-slim AS build

WORKDIR /app
RUN corepack enable

# Dependencies first, so a source-only change does not re-resolve the whole tree.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# Prune to production dependencies in place, so the runtime stage copies a tree that is
# already correct rather than reinstalling and risking a different resolution.
RUN pnpm prune --prod


FROM node:20-slim AS runtime

# git is a runtime dependency, not a build one: the reviewer shells out to it for every
# diff. Without it the image builds cleanly and fails on the first review.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# A first reference lookup on a large repository was measured at ~3GB. The default heap
# does not survive it, and the failure is an OOM kill rather than an error message.
ENV NODE_OPTIONS=--max-old-space-size=8192

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Repositories are mounted here and read; nothing is written to them.
RUN useradd --create-home --uid 10001 ripple \
    && mkdir -p /workspace \
    && chown ripple:ripple /workspace
USER ripple
WORKDIR /workspace

EXPOSE 3000
ENTRYPOINT ["node", "/app/dist/cli/main-cli.js"]
CMD ["--help"]
