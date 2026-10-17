# Deployment guide

A production install of the Modlight server with Docker: configuration, the reverse
proxy, storage, upgrades — and the proxy settings that decide whether large uploads work.

---

## Architecture

Modlight runs as one Node process (`server.ts`) that serves:

- the Next.js app (panel, sign-in, public file pages),
- the **tus** endpoint for resumable browser uploads (`/api/files`),
- the **busboy** streaming endpoint for ShareX (`/upload`),
- the file routes (`/{user}/{code}…`).

```
        ┌─────────────┐      ┌──────────────────┐      ┌────────────┐
client ─┤ Caddy/nginx ├──────┤ Modlight (Node)  ├──────┤ PostgreSQL │
        │   (TLS)     │      │ Next + tus + api │      └────────────┘
        └─────────────┘      └────────┬─────────┘
                                      │
                               ┌──────┴───────┐
                               │ local disk   │
                               │   or  S3     │
                               └──────────────┘
```

---

## 1. Configure

From the repository root:

```bash
./setup.sh
```

It asks for your domain, HTTPS mode, storage, account limits and mail, generates the
secrets, writes `.env` (mode `600`) and offers to start the stack. Running it again later
offers your previous answers as defaults and **keeps the existing secrets**: a new
`AUTH_SECRET` would sign everyone out, a new `SETTINGS_ENCRYPTION_KEY` would make stored
secrets unreadable, and a new `POSTGRES_PASSWORD` would lock the app out of its database.
The previous `.env` is saved as `.env.backup-<date>`.

For scripted installs every question has an environment variable (`./setup.sh --help`):

```bash
DOMAIN=files.example.com PROXY=caddy STORAGE=local START=yes ./setup.sh --yes
```

### By hand

`setup.sh` only writes a file; you can write it yourself. Start from
[`.env.example`](../.env.example), which documents every variable. Required in production,
the app refuses to start without them:

```dotenv
APP_URL=https://files.example.com     # your public URL, no trailing slash
AUTH_SECRET=...                       # openssl rand -base64 32   (32+ characters)
POSTGRES_PASSWORD=...                 # openssl rand -hex 24      (hex: it goes into a URL)
SETTINGS_ENCRYPTION_KEY=...           # openssl rand -base64 32   (strongly recommended)
```

`SETTINGS_ENCRYPTION_KEY` encrypts the secrets kept in the database (the SMTP password,
the registration key). Without it the key is derived from `AUTH_SECRET`, so rotating
`AUTH_SECRET` later would make those secrets unreadable.

And the lines that tell Compose what to run, so that a plain `docker compose` in the
repository root means production:

```dotenv
COMPOSE_PATH_SEPARATOR=,
COMPOSE_FILE=docker/docker-compose.prod.yml
COMPOSE_PROFILES=caddy                # leave empty behind your own proxy (section 3)
CADDY_SITES=files.example.com         # every hostname Caddy should get a certificate for
```

Leave `REGISTRATION_ENABLED=false`. The first account on an empty install is always
allowed and becomes the administrator; nobody else can register until you open
registration from the admin panel. The variable is only a starting value: once the app
has booted, the admin panel owns the setting.

### Storage

Local disk is the default. For any S3-compatible service (AWS, Cloudflare R2, Backblaze
B2, MinIO, DigitalOcean Spaces):

```dotenv
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=modlight
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true              # for MinIO and other path-style endpoints
```

---

## 2. Start

```bash
docker compose up -d --build
```

This builds the image and starts the app, PostgreSQL and (in Caddy mode) Caddy, which
obtains HTTPS certificates on its own. **Database migrations run automatically every time
the app starts**; there is no separate migration step. The first build takes a few minutes.

Open your `APP_URL` and register. That first account is the administrator.

> The `docker-compose.yml` in the repository root is different: it only starts a
> development database for `pnpm dev`. The `COMPOSE_FILE` line in a production `.env` is
> what makes `docker compose` pick the production stack instead.

---

## 3. Large uploads and the reverse proxy

This is the section that matters most. Self-hosted file hosts fail on big uploads almost
always because the **reverse proxy** caps the request size or **buffers the whole body**
before passing it on. Modlight streams uploads end to end — but only if the proxy lets
the bytes through.

Your proxy must:

1. **not cap the body size** — the app enforces `MAX_UPLOAD_SIZE` itself;
2. **not buffer the request body** — stream it straight to the app;
3. **use long timeouts** — so slow connections and multi-gigabyte files are not cut off;
4. **send the real client address as `X-Real-IP`, overwriting what the client sent.**

The fourth one is a security requirement, not a performance one. `X-Real-IP` is the only
header the app trusts to identify a caller for rate limiting. If the proxy passes the
client's own value through, anyone can claim a new address on every request — which
switches off every limit at once: sign-in, file passwords, the registration key.

### Caddy

The bundled [`docker/Caddyfile`](../docker/Caddyfile) already does all four. Its site list
comes from `CADDY_SITES`, so it never needs editing:

```caddy
{$CADDY_SITES} {
	encode zstd gzip

	request_body {
		max_size 0
	}

	reverse_proxy app:3000 {
		transport http {
			read_timeout 0
			write_timeout 0
			dial_timeout 30s
		}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-For {remote_host}
		header_up Host {host}
	}
}
```

### nginx, Traefik or another proxy you already run

Choose **my own reverse proxy** in `setup.sh`. Caddy then never starts, and the app is
published on `127.0.0.1:APP_PORT` through `docker/docker-compose.expose.yml`. `setup.sh`
also writes `modlight.nginx.conf`, a server block with your hostnames and port filled in.

By hand, that is:

```dotenv
COMPOSE_FILE=docker/docker-compose.prod.yml,docker/docker-compose.expose.yml
COMPOSE_PROFILES=
APP_PORT=3000
```

The app is bound to `127.0.0.1`, not `0.0.0.0`, on purpose: Docker writes its own firewall
rules ahead of ufw, so a port published on all interfaces stays reachable from the internet
even with the firewall closed, and the app trusts `X-Real-IP` from whoever connects.

**Proxy in a container** instead (a shared Docker network)? Leave out the expose file,
attach the `app` service to the proxy's network and address it as `app:3000`.

For nginx, see [`docker/nginx.example.conf`](../docker/nginx.example.conf). The directives
that matter:

```nginx
server {
    server_name files.example.com;

    client_max_body_size 0;              # no size cap

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_request_buffering off;     # stream the body
        proxy_buffering off;

        proxy_connect_timeout 60s;
        proxy_send_timeout    3600s;
        proxy_read_timeout    3600s;
        send_timeout          3600s;
    }
}
```

> **aaPanel, Nginx UI and similar panels** generate site configs with neither
> `client_max_body_size` nor `proxy_request_buffering`, so they inherit nginx's 1 MB limit
> and buffer whole files. Add the directives above — this is the most common reason large
> uploads fail.

| Without these settings | With them |
|---|---|
| nginx's 1 MB default → `413` on anything large | no limit, enforced by the app |
| the proxy buffers a multi-gigabyte file first | streamed straight through |
| 60-second default timeout → `504` on slow links | never cut off |

---

## 4. Storage and disks

All uploaded files live under `/app/data` in the container: the `appdata` Docker volume by
default. To keep them on a dedicated disk, give `setup.sh` a directory, or set it yourself:

```dotenv
MODLIGHT_DATA=/mnt/storage/modlight     # owned by uid 1000: chown 1000:1000 /mnt/storage/modlight
```

**Keep storage, `TUS_TMP_PATH` and `UPLOAD_TMP_PATH` on the same filesystem** — by default
all three are under `/app/data`. Finishing an upload renames the temporary file into
storage, and a rename cannot cross filesystems: split them across disks and every upload
fails after all of its bytes have arrived.

With S3, resumable uploads become multipart uploads; the bucket needs no CORS rules,
because all traffic goes through the app.

---

## 5. Upgrading

```bash
git pull
docker compose up -d --build
```

Your `.env` is not tracked by git, so pulling never touches it. Run `./setup.sh` again only
if you want to change a setting.

New migrations apply on start. Each rebuild leaves the previous image behind untagged;
remove those with `docker image prune` (without `-a`, which would also remove images other
stacks on the machine still use).

---

## 6. Backups

Back up two things:

- **the database** — `docker compose exec -T postgres pg_dump -U modlight modlight > modlight.sql`
- **the files**: the `appdata` volume (or your `MODLIGHT_DATA` directory), or your S3 bucket.
- **`.env`**: without its secrets, the stored SMTP password and the sessions cannot be read.

The database alone is worth a lot: accounts, folders, links and settings live there, and
without it the files are a pile nobody can find their way through.

---

## 7. Health and logs

- The app answers `GET /api/health`; the compose file uses it as the healthcheck.
- Logs go to stdout and stderr: `docker compose logs -f app`.

---

## Checklist

- [ ] `APP_URL` is the real public URL, without a trailing slash
- [ ] `AUTH_SECRET`, `POSTGRES_PASSWORD` and `SETTINGS_ENCRYPTION_KEY` are long and random (`setup.sh` does this)
- [ ] The proxy has no body-size limit, does not buffer requests, and uses long timeouts
- [ ] The proxy sets `X-Real-IP` to the real client address
- [ ] Storage and the upload temp directories are on one filesystem
- [ ] You registered the first account (the administrator) before sharing the URL
- [ ] Database backups are scheduled
