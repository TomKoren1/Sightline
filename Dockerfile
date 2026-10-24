# Container images for the API and the built frontend.
#
# Three targets:
#
#   --target api     the compiled server, worker and migrations, on production
#                    dependencies only
#   --target web     nginx serving the built SPA and proxying /api to the API
#   --target tools   the whole workspace on tsx, for the mock seeder
#
# Used only by the optional `app` profile in docker-compose.yml. The documented
# local-development path does not build these, so nothing here can break it.
#
# Deliberately not a hot-reload dev container: this is for running the product,
# not developing inside it, and a production-shaped image avoids mounting
# node_modules into a container, which is where containerised Node setups rot.

# --- dependencies ----------------------------------------------------------
# Workspace manifests are copied before the source so `npm ci` is cached and a
# code change does not reinstall the tree.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mock-aws/package.json packages/mock-aws/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `npm ci`, not `npm install`: the lockfile is the contract, and a build that
# silently resolves a different tree than CI tested is not a reproduction.
RUN npm ci

# --- API build -------------------------------------------------------------
# The server as JavaScript, bundled by esbuild - the transform tsx applies in
# development, so the two cannot disagree (apps/api/build.mjs).
FROM deps AS apibuild
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN npm run build -w @sightline/api

# --- API production dependencies --------------------------------------------
# The API's runtime dependencies and nothing else: no tsx, no esbuild, no
# drizzle-kit, no vitest, and none of the frontend's. Workspace packages are
# bundled into the build, so their links here are never followed.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS apideps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mock-aws/package.json packages/mock-aws/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @sightline/api --include-workspace-root=false  && npm cache clean --force

# --- API runtime -----------------------------------------------------------
# Node, the build, its migrations and its production dependencies. npm is
# removed: nothing here runs through it - every command is `node <file>`,
# which also delivers SIGTERM to the server rather than to an npm wrapper -
# and a package manager in a production image is only attack surface.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS api
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=apideps /app/node_modules node_modules
COPY --from=apideps /app/apps/api/ apps/api/
COPY apps/api/package.json apps/api/
COPY apps/api/drizzle/ apps/api/drizzle/
COPY --from=apibuild /app/apps/api/dist/ apps/api/dist/
ENV NODE_ENV=production
# Fastify must accept connections from the nginx container, not just loopback.
ENV BACKEND_HOST=0.0.0.0
EXPOSE 3000
# Non-root. The `node` user ships with the image and `/app` only needs to be
# read; the server writes nothing at runtime.
USER node
# The server applies the Postgres schema on boot, so no migrate step is needed.
# The worker, migrations and the restricted role's password are the other
# entry points: node apps/api/dist/{worker,migrate,app-role}.js.
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]

# --- tools -----------------------------------------------------------------
# The whole workspace on tsx, for what is not part of the product: the compose
# profile's one-shot mock seeder, which runs `npm run seed`.
FROM deps AS tools
WORKDIR /app
COPY tsconfig.base.json ./
# Root `package.json` scripts run `scripts/deps.mjs` first, so the seeder needs
# the directory; with devDependencies installed it finds tsx and exits.
COPY scripts/ scripts/
COPY packages/ packages/
COPY apps/api/ apps/api/
USER node

# --- frontend build --------------------------------------------------------
FROM deps AS webbuild
WORKDIR /app
COPY tsconfig.base.json ./
# The privacy policy and the terms, which the frontend imports with Vite's
# `?raw` so there is one copy of each rather than the same text in a `.tsx`.
# They live at the repository root because that is where GitHub renders them and
# where every link in the documents points - so the build needs them here too.
#
# Their absence failed this build and nothing else: `npm run build` locally has
# the whole repository, so the import resolved, and only the image - which
# copies directories deliberately rather than everything - could notice.
# `infra/webBuildInputs.test.ts` now checks the two agree.
COPY PRIVACY.md TERMS.md ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN npm run build -w @sightline/web

# --- frontend runtime ------------------------------------------------------
FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951 AS web
# Patched Alpine packages over the pinned base: fixes land in Alpine before a
# new nginx image is cut (brotli-libs, CVE-2026-111497, did), and the release
# scan fails on any fixable HIGH.
RUN apk upgrade --no-cache
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=webbuild /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
