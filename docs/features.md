# Modlight — features

A complete tour of what Modlight does. Modlight is a modern, self-hosted file &
screenshot host focused on **rock-solid
large-file uploads**, **first-class ShareX support**, and a **polished, themeable UI**.

## Uploading

- **ShareX / single-POST API** — `POST /upload`, multipart field `upload`, auth via
  the `x-api-key` header (or legacy `token` field). Streams straight to storage with
  **no size cap and no buffering**, so multi-GB uploads don't drop. Response is
  JSON (`url`, `raw_url`, `deletionUrl`), the shape ShareX configs expect.
- **Web upload (resumable)** — drag, drop, or paste in the browser. Uses the **tus**
  protocol via Uppy, so an interrupted upload **resumes from the last chunk** instead
  of restarting — built for flaky connections and huge files.
- **One-click ShareX setup** — the ShareX & API page has a single button (ShareX logo)
  that mints a token and downloads a ready-to-import `.sxcu` immediately.

## Links & sharing

- **Public link** `/{user}/{code}.{ext}` with a rich preview page and Open Graph /
  oEmbed cards (Discord, Twitter, Telegram).
- **Raw** `/{user}/{code}/raw.{ext}` with HTTP Range / 206 (video seeking), SVG/HTML
  served as `text/plain` (anti-XSS).
- **Multiple copy formats** — Direct, Raw, Markdown, BBCode, HTML.
- **Vanity URLs**, **public/private** toggle.
- **Link settings** per file: **expiring links** (time-based), **one-time / view-limited**
  (burn after N views), and **password-protected** files.
- **Albums / folders** — group uploads; make an album public to share a single link to a
  **beautiful gallery** at `/a/{user}/{slug}` (rendered in the owner's theme).
- **Download album as ZIP** — stream every file in a public album as one archive.
- **Public user gallery** `/u/{user}` — a shareable profile showing all of a user's public files.
- **URL shortener** — `/s/{code}` with click tracking, optional expiry, and an **optional
  password gate** (visitors enter the password before being redirected).
- **Pastebin** — share code/text with a language hint; pastes reuse links, expiry and password.

## Media tools

- **Thumbnails** for images (sharp) and **first-frame posters for video**, with hover-to-play
  for video and hover-to-animate for GIFs.
- **Text files preview their content** on the link page (with line numbers).
- **Convert / "Download as…"** — images to **PDF**, PNG, JPG, WebP, or AVIF on the fly.
- **Tagging** (manual + optional auto-tagging by type) and **search / sort / filter**.
- **Right-click to multi-select** files, with a floating action bar (trash / publish / download).

## Accounts & admin

- Email + password auth, email verification, password reset, **TOTP 2FA** (with QR), roles.
- The **first registered user becomes admin**. Open registration is admin-toggleable.
- Per-user **storage quotas**; per-user **API tokens** for ShareX.
- Admin: global settings, user management, stats.

## Personalization

- **Themes** (Profile → Appearance): Modern, Liquid Glass, Synthwave, Terminal, Paper,
  Windows 98. Your theme styles **your panel and your public links** (visitors see it).
- Light / dark / system (for theme variants that support it).
- **Language by system locale** — Polish browsers get Polish, everyone else English; users
  can override (Auto / Polski / English) in their profile.

## Storage & deployment

- Pluggable storage: **local disk** or any **S3-compatible** bucket (AWS S3, MinIO, R2,
  Spaces, Backblaze). tus + busboy stream directly to the backend.
- Ships with **Docker** (app + PostgreSQL, plus Caddy for automatic HTTPS) and a
  configurator, `./setup.sh`, that writes the whole `.env` from a few questions. Works behind
  your own proxy too, with an nginx block tuned for large uploads (`client_max_body_size 0`,
  `proxy_request_buffering off`). See [`deployment.md`](deployment.md).
- Fonts are bundled (no Google Fonts fetch at build), so offline/CI builds always succeed.

