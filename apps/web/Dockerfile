# The frontend: built once, served by nginx.
#
# A static bundle rather than a Node server, because there is nothing to run -
# the API is a separate Service and the ingress routes /api and /auth to it.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/mock-aws/package.json packages/mock-aws/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @daveio/web

FROM nginx:1.27-alpine AS runtime

# Single-page app: every unknown path is the app's own route, not a 404 -
# otherwise a refresh on any view returns nginx's error page. /api and /auth
# never reach here; the ingress sends them to the API.
RUN printf '%s\n' \
  'server {' \
  '  listen 80;' \
  '  root /usr/share/nginx/html;' \
  '  location / { try_files $uri $uri/ /index.html; }' \
  '  location = /index.html { add_header Cache-Control "no-store"; }' \
  '}' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
