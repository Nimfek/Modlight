# syntax=docker/dockerfile:1

# ── deps: full install (incl. dev) for building ──────────────────────────────
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── build: next build + bundle the custom server & migrator ──────────────────
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# Next evaluates headers() at BUILD time and bakes the result into the routes
# manifest, so the Content-Security-Policy has to know every hostname this
# deployment answers on before the image exists. Without these the policy falls
# back to 'self' and thumbnails served from a second domain are blocked by the
# browser — silently, with a perfectly healthy 200 on the wire.
ARG APP_URL
ARG APP_DOMAINS
ARG SHORTLINK_URL
ENV APP_URL=$APP_URL APP_DOMAINS=$APP_DOMAINS SHORTLINK_URL=$SHORTLINK_URL

RUN pnpm build

# ── runtime: production-only deps + build artifacts ──────────────────────────
FROM node:24-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

# ffmpeg + ffprobe: the audio/video half of "download as…" (lib/media/av-*.ts).
#
# Runtime stage only. The build stage never runs a conversion, and putting this
# in a shared earlier layer would carry ~450 MiB through the builder for nothing.
#
# Cost, measured rather than estimated: 200 packages, 448 MiB after
# `apt-get clean` and removing the lists. That is a real price on a small VPS,
# and it buys the things Debian's ffmpeg links
# against - libavcodec and every decoder behind it. Bookworm ships 5.1.9, which
# was verified to demux the animated AVIF this feature exists for (43 frames of
# AV1 that libvips cannot reach), so there is no reason to change the base image
# or to fetch a static build from the internet at build time.
#
# --no-install-recommends is load-bearing: with recommends the same install
# drags in the X11 and desktop stack that only `ffplay` would ever use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x docker/entrypoint.sh && mkdir -p data/storage data/tus data/tmp

# Run unprivileged. This process parses other people's files with sharp/libvips
# and accepts uploads from the open internet; a flaw in that path should not
# start out as root.
#
# uid 1000 is not arbitrary: it is the node image's `node` user, and the most
# common first user on a Linux host - so files copied onto a bind-mounted disk
# are usually readable and writable without a `chown -R` over millions of
# inodes. Only the few directories created by the image itself need handing over.
# Everything the process writes at runtime must belong to it. /app/data holds
# uploads; /app/.next/cache is Next's image-optimisation cache (also backed by a
# volume in production, but a bare `docker run` has to work too).
RUN mkdir -p /app/.next/cache && chown -R node:node /app/data /app/.next
USER node

EXPOSE 3000
# Applies DB migrations, then starts the custom Node server.
CMD ["sh", "docker/entrypoint.sh"]
