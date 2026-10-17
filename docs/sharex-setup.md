# ShareX setup

Modlight is **drop-in compatible with ShareX**. This guide shows the one-click path, the manual path, and how to use custom URLs and troubleshoot uploads.

> Replace `https://your-domain.com` below with your instance's `APP_URL`.

---

## The fast path (one click)

1. Sign in to your Modlight instance.
2. Open **ShareX & API** in the dashboard sidebar.
3. Click **Create token**, give it a name (e.g. `desktop`), and **download the `.sxcu`** file.
4. **Double-click the `.sxcu`.** ShareX imports it and asks to set it as the active uploader for images, text, and files — accept.
5. Press your capture hotkey (default `Ctrl + Print Screen` for region capture). The screenshot uploads and the **public URL is copied to your clipboard**.

That's it. Every capture or dragged file now lands on your server.

---

## How the upload works (the contract)

ShareX sends a single multipart `POST` to `/upload`:

| Field / header | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://your-domain.com/upload` |
| Body | `MultipartFormData` |
| File field name | `upload` |
| Auth (preferred) | header `x-api-key: <your-token>` |
| Auth (alternative) | multipart field `token: <your-token>` |
| Optional | field `code` — request a specific custom URL slug |

On success the server responds with JSON:

```json
{
  "message": "OK",
  "url": "https://your-domain.com/ab12c/Kx7nVq2pL3.png",
  "raw_url": "https://your-domain.com/ab12c/Kx7nVq2pL3/raw.png",
  "deletionUrl": "https://your-domain.com/ab12c/Kx7nVq2pL3/delete/<delete-token>",
  "version": "1"
}
```

ShareX is configured to use `{json:url}` as the resulting link.

---

## Manual setup

If you'd rather not import the file, create a **Custom uploader** in ShareX
(*Destinations → Custom uploader settings → New*) with these values:

- **Name:** `Modlight`
- **Destination type:** Image, Text, File uploader
- **Request method:** `POST`
- **Request URL:** `https://your-domain.com/upload`
- **Body:** `Form data (multipart)`
- **File form name:** `upload`
- **Headers:** add `x-api-key` = `<your-token>`
- **URL:** `{json:url}`
- **Thumbnail URL:** `{json:url}` (or append `/raw` for the raw bytes)
- **Deletion URL:** `{json:deletionUrl}`

Equivalent `.sxcu` JSON:

```json
{
  "Version": "16.1.0",
  "Name": "Modlight",
  "DestinationType": "ImageUploader, TextUploader, FileUploader",
  "RequestMethod": "POST",
  "RequestURL": "https://your-domain.com/upload",
  "Body": "MultipartFormData",
  "FileFormName": "upload",
  "Headers": { "x-api-key": "YOUR_TOKEN_HERE" },
  "URL": "{json:url}",
  "ThumbnailURL": "{json:url}/raw",
  "DeletionURL": "{json:deletionUrl}"
}
```

---

## Custom URLs (vanity codes)

Send an extra `code` form field to request a specific slug:

```bash
curl -F "upload=@screenshot.png" -F "code=launch-banner" \
  -H "x-api-key: YOUR_TOKEN" https://your-domain.com/upload
```

If the code is already taken the server responds `409 Conflict`. Omit `code` to get an
auto-generated, human-readable slug.

---

## Test it with curl

A quick way to confirm a token works without ShareX:

```bash
curl -F "upload=@/path/to/file.png" \
  -H "x-api-key: YOUR_TOKEN" \
  https://your-domain.com/upload
```

You should get back the JSON response above with HTTP `200`.

---

## Other clients

The same `/upload` contract works from any tool that can send a multipart POST with a
header or `token` field — shell scripts, Flameshot wrappers, KDE Spectacle scripts, mobile
share-sheet shortcuts, etc.

```bash
#!/usr/bin/env bash
# upload.sh <file>
curl -s -F "upload=@$1" -H "x-api-key: $MODLIGHT_TOKEN" \
  https://your-domain.com/upload | grep -oP '"url":"\K[^"]+'
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 Unauthorized` | Token missing, wrong, or revoked. Regenerate it in **ShareX & API**. |
| `404` on the token | The token doesn't exist on this instance. |
| `409 Conflict` | Your custom `code` is already in use — pick another. |
| `413 Request Entity Too Large` | Your reverse proxy is capping the body. Set `client_max_body_size 0` (nginx) or `request_body { max_size 0 }` (Caddy). See [deployment.md](deployment.md). |
| `504 Gateway Timeout` on big files | Proxy timeouts too short. Raise `proxy_read_timeout` / `proxy_send_timeout` (nginx) or set `read_timeout 0` / `write_timeout 0` (Caddy). |
| `507 Insufficient Storage` | You've hit your disk quota. Free space or ask an admin to raise it. |
| Upload succeeds but link 404s | Check `APP_URL` is set correctly — it builds the returned URLs. |

For large-file reliability specifics, see **[Large uploads need a properly configured reverse proxy](deployment.md#large-file-proxy-tuning)**.
