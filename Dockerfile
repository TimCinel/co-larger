# co-larger: the static site, served by unprivileged nginx. See docker/README.md
# and the "Run with Docker" section of the README. Build with docker/build.sh
# (multi-arch, pushes), or `docker build -t co-larger .` for a local image.
#
# Stage one runs on the build machine's own architecture (the output is plain
# static files, identical for every target), so cross-builds never run npm
# under emulation.
FROM --platform=$BUILDPLATFORM docker.io/library/node:24-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
# The image has no Git metadata (.dockerignore keeps .git out), so the commit
# is passed in: docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
# Without it the page shows the version only. vite.config.ts reads it.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
RUN npm run build

# nginx 1.30 (stable), Alpine, running as uid 101 and listening on 8080.
FROM docker.io/nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
EXPOSE 8080
