# Container images for the API and the built frontend.
#
# Two targets, built from one dependency layer:
#
#   --target api   Node runtime for the Fastify server and the CLIs
#   --target web   nginx serving the built SPA and proxying /api to the API
#
# Used only by the optional `app` profile in docker-compose.yml. The documented
# local-development path does not build these, so nothing here can break it.
#
# Deliberately not a hot-reload dev container: a reviewer wants to see the
# product run, not develop inside it, and a production-shaped image avoids
# mounting node_modules into a container, which is where containerised Node
# setups usually rot.

# --- dependencies ----------------------------------------------------------
# Workspace manifests are copied before the source so `npm ci` is cached and a
# code change does not reinstall the tree.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mock-aws/package.json packages/mock-aws/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `npm ci`, not `npm install`: the lockfile is the contract, and a build that
# silently resolves a different tree than CI tested is not a reproduction.
RUN npm ci

# --- API runtime -----------------------------------------------------------
# The API runs through tsx rather than a compiled bundle, matching how it runs
# locally, so devDependencies are part of the runtime here. That is a deliberate
# trade: a slightly larger image in exchange for one execution path instead of
# two, which is one fewer thing that can differ between this and a laptop.
FROM deps AS api
WORKDIR /app
COPY tsconfig.base.json vitest.config.ts ./
# Root `package.json` scripts run `scripts/deps.mjs` first, so an image that runs
# one - the compose `seed` service runs `npm run seed` - needs the directory. Its
# absence failed the whole `app` profile at the seeding step, before the API was
# ever reached (engineering log #51). Here the guard is a no-op: `npm ci` above
# installed devDependencies deliberately, so it finds tsx and exits immediately.
COPY scripts/ scripts/
COPY packages/ packages/
COPY apps/api/ apps/api/
# Fastify must accept connections from the nginx container, not just loopback.
ENV BACKEND_HOST=0.0.0.0
EXPOSE 3000
# The server applies the Postgres schema on boot, so no migrate step is needed.
CMD ["npm", "run", "start", "-w", "@daveio/api"]

# --- frontend build --------------------------------------------------------
FROM deps AS webbuild
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN npm run build -w @daveio/web

# --- frontend runtime ------------------------------------------------------
FROM nginx:alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=webbuild /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
