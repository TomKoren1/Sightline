# The API and the scan worker: one image, two commands.
#
# They share every dependency and all of the configuration, so a second image
# would be a second way for them to drift - which presents as "scans work in
# the API and fail in the worker", a confusing shape of bug to chase.

FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests first, so `npm ci` is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/mock-aws/package.json packages/mock-aws/
RUN npm ci --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app

# tini, because Node as PID 1 does not reap children or forward signals
# properly - and the worker's SIGTERM handler exists precisely so a deploy
# does not orphan a scan halfway through.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# No build step: this project runs TypeScript through tsx everywhere, and
# introducing a compile for the container only would mean the thing tested in
# CI is not the thing that runs in the cluster.
ENV NODE_ENV=production
ENV BACKEND_HOST=0.0.0.0
ENV BACKEND_PORT=3000
EXPOSE 3000

# Runs unprivileged. The node image ships this user; it owns nothing here
# because the container writes nothing to disk.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start", "-w", "@daveio/api"]
