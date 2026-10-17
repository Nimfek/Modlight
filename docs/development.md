# Development

How the server is put together, how to run it locally, and what each script does.
For a production install see [`deployment.md`](deployment.md).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Runtime | Node.js 24 with a custom server (`server.ts`) |
| Database | PostgreSQL 17 through Drizzle ORM |
| Auth | Better Auth: sessions, two-factor, admin roles |
| Uploads | tus (resumable, from the browser) and busboy (streaming, for ShareX) |
| Media | sharp (libvips) for images, FFmpeg for audio and video |
| UI | Tailwind CSS v4, shadcn/ui, media-chrome for the player |
| i18n | next-intl, English and Polish |
| Tests | Vitest (unit and integration), Playwright (end-to-end) |

## Why a custom server

`server.ts` takes two paths before Next.js ever sees them:

- **`/upload`**, the ShareX endpoint. The request body is streamed to storage with
  busboy, never buffered, so a multi-gigabyte file costs no memory.
- **`/api/files/*`**, the tus endpoint for resumable browser uploads.

Everything else goes to Next.js. This is also why the app is not built with
`output: "standalone"`: the server is bundled separately with esbuild into `dist/`.

## Running locally

```bash
pnpm install
docker compose up -d        # PostgreSQL on localhost:5433
cp .env.example .env        # works as-is for development
pnpm db:migrate
pnpm dev                    # http://localhost:8420
```

The first account you register becomes the administrator.

The `docker-compose.yml` in the repository root starts only that development database.
The production stack is `docker/docker-compose.prod.yml`, which `setup.sh` selects through
`COMPOSE_FILE` in `.env`; a development `.env` copied from `.env.example` does not set it,
so `docker compose` keeps meaning the development database.

## Configuration

Everything is configured through environment variables; [`.env.example`](../.env.example)
documents each one. The ones that matter most:

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL. Used in links, embeds and the generated ShareX config. |
| `APP_DOMAINS` | Extra hostnames the same install answers on. Users pick which one their links use. |
| `SHORTLINK_URL` | Optional separate hostname for short links (`s.example.com/name`). |
| `AUTH_SECRET` | Signs sessions and verification links. 32+ random characters; required in production. |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts secrets stored in the database (SMTP password, registration key). |
| `POSTGRES_PASSWORD` | Used by the production compose to build `DATABASE_URL`. Defaults are refused. |
| `STORAGE_DRIVER` | `local` or `s3`, with the matching `STORAGE_LOCAL_PATH` or `S3_*` variables. |
| `MAX_UPLOAD_SIZE` | Bytes; `0` means no limit. |
| `REGISTRATION_ENABLED` | Seed value only. After first boot the admin panel owns this switch. |
| `SMTP_*`, `MAIL_FROM` | Outgoing mail. Can be configured from the admin panel instead. |
| `TRUST_PROXY` | Set when running behind a reverse proxy, which must send `X-Real-IP`. |

`APP_URL`, `APP_DOMAINS` and `SHORTLINK_URL` are also read at build time (the
Content-Security-Policy is baked into the build), so changing them needs a rebuild.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Development server with reload |
| `pnpm build` | Next.js build plus the bundled server in `dist/` |
| `pnpm start` | Runs the production build |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Unit and integration tests |
| `pnpm test:e2e` | End-to-end tests (needs a running database) |
| `pnpm db:generate` | Generates a migration from schema changes |
| `pnpm db:migrate` | Applies migrations |
| `pnpm db:fix-mime` | Re-detects file types for existing uploads (dry run unless `--apply`) |
| `pnpm db:av-meta` | Fills in video dimensions, duration and frame rate (dry run unless `--apply`) |

`pnpm build` also runs `scripts/check-server-bundle.mjs`, which resolves every external
import of the bundled server the way Node will. A server-only import that slips into
`dist/server.js` would otherwise crash the container before it starts listening; neither
`tsc`, Vitest nor `next build` notices it.

Scripts that run inside the production container (`scripts/publish-release.ts`
and the `db:*` maintenance scripts) are bundled into
`dist/scripts/` and must also be listed in `.dockerignore`, which keeps `scripts/` out of
the image and lets files back in one by one. A test fails if one is missing.

## Publishing a desktop app release

The update channel for [Modlight App](https://github.com/Nimfek/Modlight-App) is served by
this server. An installer is an ordinary upload; the channel stores only a pointer to it,
and the SHA-256 the app verifies is the upload's checksum.

```bash
docker compose cp Modlight-1.0.0-setup-x64.exe app:/app/data/tmp/
docker compose exec app node dist/scripts/publish-release.js \
  --file /app/data/tmp/Modlight-1.0.0-setup-x64.exe --version 1.0.0 \
  --owner you@example.com --notes "What changed" --apply
```

Without `--apply` it only reports what it would do. The app checks
`GET /api/releases/app` on the server it was built for (see the app's README).
