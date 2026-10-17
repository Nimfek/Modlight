#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Modlight setup: writes .env for a production install with Docker Compose.
#
#   ./setup.sh             answer a few questions, write .env, optionally start
#   ./setup.sh --yes       accept every default without asking
#   ./setup.sh --help      list the variables that answer questions in advance
#
# Re-running is safe. Your previous answers become the defaults, and the
# secrets already in .env are kept: changing AUTH_SECRET signs everyone out,
# changing SETTINGS_ENCRYPTION_KEY makes the stored SMTP password unreadable,
# and changing POSTGRES_PASSWORD locks the app out of its own database.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"
NGINX_FILE="modlight.nginx.conf"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./setup.sh [--yes]

Writes .env in this directory, then offers to run `docker compose up -d --build`.

Any question can be answered ahead of time with an environment variable.
Together with --yes that gives an unattended install, for example:

  DOMAIN=files.example.com PROXY=caddy ./setup.sh --yes

  DOMAIN            main hostname, e.g. files.example.com
  EXTRA_DOMAINS     more hostnames serving the same files, comma-separated
  SHORT_DOMAIN      hostname for short links, e.g. s.example.com (optional)
  APP_NAME          name shown in the panel and in e-mails
  PROXY             caddy | external
  APP_PORT          port the app listens on for your own proxy (external only)
  APP_SCHEME        https | http   (external only; Caddy is always https)
  STORAGE           local | s3
  MODLIGHT_DATA     host directory for uploads (empty = Docker volume)
  S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  S3_FORCE_PATH_STYLE
  MAX_UPLOAD        largest upload, e.g. 20G (0 = no limit)
  USER_QUOTA        default quota per account, e.g. 50G (-1 = unlimited)
  OPEN_REGISTRATION yes | no
  SETUP_MAIL        yes | no, then SMTP_HOST SMTP_PORT SMTP_SECURITY
                    SMTP_USER SMTP_PASSWORD MAIL_FROM MAIL_FROM_NAME
  START             yes | no   (start the stack when done)
EOF
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── Output helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; D=""; G=""; Y=""; R=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$B$C" "$*" "$N"; }
note() { printf '%s%s%s\n' "$D" "$*" "$N"; }
warn() { printf '%s! %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# Questions read from the terminal, never from a pipe: `curl … | bash` would
# otherwise feed the script its own source as answers.
INPUT=/dev/tty
if ! { : <"$INPUT"; } 2>/dev/null; then
  INPUT=/dev/stdin
  [ "$ASSUME_YES" = 1 ] || [ -t 0 ] || die "No terminal to ask questions on. Run it in a terminal, or pass --yes with the answers in environment variables (see --help)."
fi

# ── Reading the previous .env ─────────────────────────────────────────────────
# Only to offer earlier answers as defaults; nothing in it is executed.
existing() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  case "$line" in
    \'*\') line=${line:1:${#line}-2} ;;
    \"*\") line=${line:1:${#line}-2}; line=${line//\$\$/\$}; line=${line//\\\"/\"}; line=${line//\\\\/\\} ;;
  esac
  printf '%s' "$line"
}

# ask VAR "Question" default — an answer already in the environment wins.
ask() {
  local var=$1 prompt=$2 def=${3-} reply
  if [ -n "${!var-}" ]; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$var" '%s' "$def"; return 0; fi
  if [ -n "$def" ]; then
    read -r -p "  $prompt ${D}[$def]${N} " reply <"$INPUT" || true
  else
    read -r -p "  $prompt " reply <"$INPUT" || true
  fi
  printf -v "$var" '%s' "${reply:-$def}"
}

# Like ask, but the typed characters are not echoed.
ask_secret() {
  local var=$1 prompt=$2 def=${3-} reply hint=""
  if [ -n "${!var-}" ]; then return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then printf -v "$var" '%s' "$def"; return 0; fi
  [ -n "$def" ] && hint=" ${D}[keep current]${N}"
  read -r -s -p "  $prompt$hint " reply <"$INPUT" || true
  printf '\n'
  printf -v "$var" '%s' "${reply:-$def}"
}

# yes_no VAR "Question" y|n — normalises the answer to yes/no.
yes_no() {
  local var=$1 prompt=$2 def=$3 hint
  [ "$def" = y ] && hint="Y/n" || hint="y/N"
  while :; do
    ask "$var" "$prompt" "$hint"
    case "$(printf '%s' "${!var}" | tr '[:upper:]' '[:lower:]')" in
      y|yes|true|1|on) printf -v "$var" yes; return 0 ;;
      n|no|false|0|off) printf -v "$var" no; return 0 ;;
      y/n) if [ "$def" = y ]; then printf -v "$var" yes; else printf -v "$var" no; fi; return 0 ;;
      *) warn "Please answer y or n."; unset "$var" ;;
    esac
  done
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# "files.example.com", "https://files.example.com/" -> "files.example.com"
host_only() {
  local h
  h=$(printf '%s' "$1" | tr -d '[:space:]')
  h=${h#*://}
  h=${h%%/*}
  lower "$h"
}

valid_host() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:[0-9]{1,5})?$'
}

# "20G", "500 MB", "0", "-1" -> bytes
to_bytes() {
  local v
  v=$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]' | sed -E 's/([KMGT])I?B$/\1/; s/^([0-9.]+)B$/\1/')
  case "$v" in -1|0) printf '%s' "$v"; return 0 ;; esac
  awk -v v="$v" 'BEGIN {
    n = v; u = substr(v, length(v)); m = 1
    if (u ~ /[KMGT]/) {
      n = substr(v, 1, length(v) - 1)
      m = (u == "K") ? 1024 : (u == "M") ? 1048576 : (u == "G") ? 1073741824 : 1099511627776
    }
    if (n !~ /^[0-9]+(\.[0-9]+)?$/) exit 1
    printf "%.0f", n * m
  }'
}

human() {
  case "$1" in -1) printf 'unlimited' ;; 0) printf 'no limit' ;; *)
    awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (b == int(b)) ? "%d %s" : "%.1f %s", b, u[i] }' ;;
  esac
}

# Random secrets. Hex for the database password: it is pasted into a URL
# (postgresql://modlight:<password>@postgres/…) and base64's "/" breaks it.
rand_b64() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"
  else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# A value as Compose's .env parser reads it back unchanged. Single quotes are
# literal; a value that itself contains one is double-quoted with \, " and $
# escaped (Compose would otherwise expand $VARIABLES inside it).
env_quote() {
  local v=$1
  if [[ "$v" =~ ^[A-Za-z0-9_./:@,+-]*$ ]]; then printf '%s' "$v"
  elif [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  else
    v=${v//\\/\\\\}; v=${v//\"/\\\"}; v=${v//\$/\$\$}
    printf '"%s"' "$v"
  fi
}

# ── Preflight ─────────────────────────────────────────────────────────────────
[ -f docker/docker-compose.prod.yml ] || die "Run this from the Modlight repository (docker/docker-compose.prod.yml not found)."

say ""
say "${B}Modlight setup${N}"
note "Writes $ENV_FILE for Docker Compose. Nothing starts until you confirm at the end."
if [ -f "$ENV_FILE" ]; then
  note "Found an existing $ENV_FILE: its values are offered as defaults and its secrets are kept."
fi

HAVE_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  HAVE_DOCKER=1
else
  warn "Docker with the Compose plugin was not found. The configuration can still be written;"
  warn "install Docker (https://docs.docker.com/engine/install/) before starting."
fi

# ── 1. Addresses ──────────────────────────────────────────────────────────────
step "1/6  Address"
note "The hostname people will use to open the panel and your links."
note "Its DNS record (A/AAAA) should already point at this machine."

prev_url=$(existing APP_URL)
prev_host=$(host_only "$prev_url")
case "$prev_host" in localhost*|"") prev_host="" ;; esac
while :; do
  ask DOMAIN "Domain (e.g. files.example.com):" "$prev_host"
  DOMAIN=$(host_only "$DOMAIN")
  if [ -z "$DOMAIN" ]; then warn "A domain is required."; unset DOMAIN; [ "$ASSUME_YES" = 1 ] && die "Set DOMAIN=… when using --yes."; continue; fi
  valid_host "$DOMAIN" && break
  warn "\"$DOMAIN\" does not look like a hostname."; unset DOMAIN
  [ "$ASSUME_YES" = 1 ] && die "Invalid DOMAIN."
done

prev_extra=$({ existing APP_DOMAINS; echo; } | tr ',' '\n' | while read -r u; do h=$(host_only "$u"); [ -n "$h" ] && [ "$h" != "$DOMAIN" ] && printf '%s,' "$h"; done || true)
prev_extra=${prev_extra%,}
note "Optional: more hostnames that serve the same files (each user picks which one their links use)."
ask EXTRA_DOMAINS "Extra domains, comma-separated (Enter to skip):" "$prev_extra"
[ "$EXTRA_DOMAINS" = "-" ] && EXTRA_DOMAINS=""

prev_short=$(host_only "$(existing SHORTLINK_URL)")
note "Optional: a separate short hostname for short links, so s.example.com/promo works."
ask SHORT_DOMAIN "Short-link domain (Enter to skip):" "$prev_short"
SHORT_DOMAIN=$(host_only "$SHORT_DOMAIN")
[ "$SHORT_DOMAIN" = "-" ] && SHORT_DOMAIN=""

prev_name=$(existing APP_NAME)
ask APP_NAME "Name shown in the panel and in e-mails:" "${prev_name:-Modlight}"

# ── 2. HTTPS / reverse proxy ──────────────────────────────────────────────────
step "2/6  HTTPS"
say "  1) Built-in Caddy: gets and renews certificates automatically (needs ports 80 and 443)"
say "  2) My own reverse proxy: nginx, Traefik, aaPanel, an existing Caddy…"
prev_proxy=caddy
if [ -f "$ENV_FILE" ] && [ "$(existing COMPOSE_PROFILES)" != "caddy" ]; then prev_proxy=external; fi
while :; do
  ask PROXY "Choose 1 or 2:" "$([ "$prev_proxy" = caddy ] && echo 1 || echo 2)"
  case "$(lower "$PROXY")" in
    1|caddy) PROXY=caddy; break ;;
    2|external|own|nginx) PROXY=external; break ;;
    *) warn "Choose 1 or 2."; unset PROXY; [ "$ASSUME_YES" = 1 ] && die "PROXY must be caddy or external." ;;
  esac
done

if [ "$PROXY" = external ]; then
  prev_port=$(existing APP_PORT)
  while :; do
    ask APP_PORT "Port for the app on 127.0.0.1 (your proxy forwards to it):" "${prev_port:-3000}"
    [[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] && break
    warn "A port is a number between 1 and 65535."; unset APP_PORT
    [ "$ASSUME_YES" = 1 ] && die "Invalid APP_PORT."
  done
  prev_scheme=$(printf '%s' "$prev_url" | sed -nE 's#^(https?)://.*#\1#p')
  ask APP_SCHEME "Does your proxy serve it over https or http?" "${prev_scheme:-https}"
  APP_SCHEME=$(lower "$APP_SCHEME")
  case "$APP_SCHEME" in https|http) ;; *) APP_SCHEME=https ;; esac
  [ "$APP_SCHEME" = http ] && warn "Over plain http, passwords and session cookies travel unencrypted. Use it only on a trusted network."
else
  APP_SCHEME=https
  APP_PORT=""
  if command -v ss >/dev/null 2>&1; then
    busy=$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -E '[:.](80|443)$' || true)
    if [ -n "$busy" ]; then
      warn "Something on this machine already listens on port 80 or 443:"
      printf '%s\n' "$busy" | sed 's/^/    /' >&2
      warn "Caddy will fail to start until it is stopped. If that is a web server you keep, choose option 2."
    fi
  fi
fi

# ── 3. Storage ────────────────────────────────────────────────────────────────
step "3/6  Storage"
say "  1) This server's disk"
say "  2) S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…)"
prev_storage=$(existing STORAGE_DRIVER)
while :; do
  ask STORAGE "Choose 1 or 2:" "$([ "$prev_storage" = s3 ] && echo 2 || echo 1)"
  case "$(lower "$STORAGE")" in
    1|local|disk) STORAGE=local; break ;;
    2|s3) STORAGE=s3; break ;;
    *) warn "Choose 1 or 2."; unset STORAGE; [ "$ASSUME_YES" = 1 ] && die "STORAGE must be local or s3." ;;
  esac
done

if [ "$STORAGE" = local ]; then
  note "Leave empty to keep files in a Docker volume, or give a directory, e.g. a dedicated"
  note "disk such as /mnt/storage/modlight. It will be created and handed to uid 1000."
  prev_data=$(existing MODLIGHT_DATA)
  [ "$prev_data" = appdata ] && prev_data=""
  ask MODLIGHT_DATA "Directory for uploads:" "$prev_data"
  if [ -n "$MODLIGHT_DATA" ]; then
    case "$MODLIGHT_DATA" in /*) ;; *) die "Use an absolute path (starting with /)." ;; esac
    MODLIGHT_DATA=${MODLIGHT_DATA%/}
  fi
else
  note "Uploads in progress still pass through a local temporary directory; finished files go to the bucket."
  ask S3_ENDPOINT "Endpoint URL (empty for AWS S3):" "$(existing S3_ENDPOINT)"
  ask S3_REGION "Region:" "$(existing S3_REGION || true)"
  [ -n "$S3_REGION" ] || S3_REGION=auto
  while :; do
    ask S3_BUCKET "Bucket name:" "$(existing S3_BUCKET)"
    [ -n "$S3_BUCKET" ] && break
    warn "A bucket is required."; unset S3_BUCKET; [ "$ASSUME_YES" = 1 ] && die "Set S3_BUCKET."
  done
  ask S3_ACCESS_KEY_ID "Access key ID:" "$(existing S3_ACCESS_KEY_ID)"
  ask_secret S3_SECRET_ACCESS_KEY "Secret access key:" "$(existing S3_SECRET_ACCESS_KEY)"
  [ -n "$S3_ACCESS_KEY_ID" ] && [ -n "$S3_SECRET_ACCESS_KEY" ] || die "S3 needs an access key ID and a secret access key."
  prev_ps=$(existing S3_FORCE_PATH_STYLE)
  yes_no S3_FORCE_PATH_STYLE "Path-style URLs? (yes for MinIO and most self-hosted S3)" "$([ "$prev_ps" = true ] && echo y || echo n)"
  MODLIGHT_DATA=""
fi

# ── 4. Accounts and limits ────────────────────────────────────────────────────
step "4/6  Accounts and limits"
note "The first account registered becomes the administrator, whatever you answer here."
prev_reg=$(existing REGISTRATION_ENABLED)
yes_no OPEN_REGISTRATION "Let anyone create an account at /register?" "$([ "$prev_reg" = true ] && echo y || echo n)"

prev_max=$(existing MAX_UPLOAD_SIZE)
while :; do
  ask MAX_UPLOAD "Largest single upload, e.g. 20G (0 = no limit):" "${prev_max:-0}"
  MAX_UPLOAD_BYTES=$(to_bytes "$MAX_UPLOAD") && [ "$MAX_UPLOAD_BYTES" != "-1" ] && break
  warn "Use a size such as 500M, 20G or 0."; unset MAX_UPLOAD
  [ "$ASSUME_YES" = 1 ] && die "Invalid MAX_UPLOAD."
done
prev_quota=$(existing DEFAULT_USER_QUOTA)
while :; do
  ask USER_QUOTA "Storage quota for new accounts, e.g. 50G (-1 = unlimited):" "${prev_quota:--1}"
  USER_QUOTA_BYTES=$(to_bytes "$USER_QUOTA") && break
  warn "Use a size such as 50G, or -1."; unset USER_QUOTA
  [ "$ASSUME_YES" = 1 ] && die "Invalid USER_QUOTA."
done

# ── 5. Mail ───────────────────────────────────────────────────────────────────
step "5/6  E-mail (optional)"
note "Needed for password resets, invitations and address confirmation."
note "You can skip this and configure mail later under Admin → Mail."
prev_smtp=$(existing SMTP_HOST)
yes_no SETUP_MAIL "Set up outgoing mail now?" "$([ -n "$prev_smtp" ] && echo y || echo n)"
if [ "$SETUP_MAIL" = yes ]; then
  while :; do
    ask SMTP_HOST "SMTP server (e.g. smtp.example.com):" "$prev_smtp"
    [ -n "$SMTP_HOST" ] && break
    warn "A server is required."; unset SMTP_HOST; [ "$ASSUME_YES" = 1 ] && die "Set SMTP_HOST."
  done
  prev_port_smtp=$(existing SMTP_PORT)
  ask SMTP_PORT "Port (587 = STARTTLS, 465 = TLS):" "${prev_port_smtp:-587}"
  prev_sec=$(existing SMTP_SECURITY)
  [ -n "$prev_sec" ] || { [ "$SMTP_PORT" = 465 ] && prev_sec=tls || prev_sec=starttls; }
  ask SMTP_SECURITY "Encryption (starttls / tls / none):" "$prev_sec"
  SMTP_SECURITY=$(lower "$SMTP_SECURITY")
  case "$SMTP_SECURITY" in starttls|tls|none) ;; *) die "Encryption must be starttls, tls or none." ;; esac
  ask SMTP_USER "Username (empty if the server needs none):" "$(existing SMTP_USER)"
  if [ -n "$SMTP_USER" ]; then
    ask_secret SMTP_PASSWORD "Password:" "$(existing SMTP_PASSWORD)"
  else
    SMTP_PASSWORD=""
  fi
  prev_from=$(existing MAIL_FROM)
  case "$prev_from" in *@localhost|"") prev_from="no-reply@$DOMAIN" ;; esac
  ask MAIL_FROM "Sender address:" "$prev_from"
  ask MAIL_FROM_NAME "Sender name:" "$(existing MAIL_FROM_NAME || true)"
  [ -n "$MAIL_FROM_NAME" ] || MAIL_FROM_NAME="$APP_NAME"
else
  SMTP_HOST=""; SMTP_PORT=587; SMTP_SECURITY=""; SMTP_USER=""; SMTP_PASSWORD=""
  MAIL_FROM="no-reply@$DOMAIN"; MAIL_FROM_NAME=""
fi

# ── Derived values ────────────────────────────────────────────────────────────
APP_URL="$APP_SCHEME://$DOMAIN"

hosts="$DOMAIN"
APP_DOMAINS=""
if [ -n "$EXTRA_DOMAINS" ]; then
  APP_DOMAINS="$APP_URL"
  IFS=',' read -r -a extra <<<"$EXTRA_DOMAINS"
  for h in "${extra[@]}"; do
    h=$(host_only "$h")
    [ -n "$h" ] && [ "$h" != "$DOMAIN" ] || continue
    valid_host "$h" || die "\"$h\" does not look like a hostname."
    APP_DOMAINS="$APP_DOMAINS,$APP_SCHEME://$h"
    hosts="$hosts, $h"
  done
  [ "$APP_DOMAINS" = "$APP_URL" ] && APP_DOMAINS=""
fi
SHORTLINK_URL=""
if [ -n "$SHORT_DOMAIN" ]; then
  valid_host "$SHORT_DOMAIN" || die "\"$SHORT_DOMAIN\" does not look like a hostname."
  SHORTLINK_URL="$APP_SCHEME://$SHORT_DOMAIN"
  case ", $hosts, " in *", $SHORT_DOMAIN, "*) ;; *) hosts="$hosts, $SHORT_DOMAIN" ;; esac
fi

if [ "$PROXY" = caddy ]; then
  COMPOSE_FILE_VALUE="docker/docker-compose.prod.yml"
  COMPOSE_PROFILES_VALUE="caddy"
else
  COMPOSE_FILE_VALUE="docker/docker-compose.prod.yml,docker/docker-compose.expose.yml"
  COMPOSE_PROFILES_VALUE=""
fi

# Secrets: keep what exists, generate what does not.
AUTH_SECRET=$(existing AUTH_SECRET)
case "$AUTH_SECRET" in ""|change-me*) AUTH_SECRET=$(rand_b64 32); AUTH_NEW=1 ;; *) AUTH_NEW=0 ;; esac
SETTINGS_ENCRYPTION_KEY=$(existing SETTINGS_ENCRYPTION_KEY)
if [ -z "$SETTINGS_ENCRYPTION_KEY" ]; then
  # On an install that already ran without one, the key is derived from
  # AUTH_SECRET; adding a new key now would orphan secrets saved under the old.
  if [ "$AUTH_NEW" = 1 ]; then SETTINGS_ENCRYPTION_KEY=$(rand_b64 32); fi
fi
POSTGRES_PASSWORD=$(existing POSTGRES_PASSWORD)
if [ -z "$POSTGRES_PASSWORD" ]; then
  POSTGRES_PASSWORD=$(rand_hex 24)
elif [[ "$POSTGRES_PASSWORD" =~ [/@:?#%] ]]; then
  warn "The existing POSTGRES_PASSWORD contains a character that breaks the database URL (/ @ : ? # %)."
  warn "It is kept, because the database was created with it. If the app cannot connect, change it in"
  warn "PostgreSQL first (ALTER USER modlight PASSWORD '…'), then here."
fi

# ── 6. Summary ────────────────────────────────────────────────────────────────
step "6/6  Summary"
printf '  %-18s %s\n' "Panel" "$APP_URL"
[ -n "$APP_DOMAINS" ] && printf '  %-18s %s\n' "Also answers on" "${APP_DOMAINS#"$APP_URL",}"
[ -n "$SHORTLINK_URL" ] && printf '  %-18s %s\n' "Short links" "$SHORTLINK_URL"
if [ "$PROXY" = caddy ]; then
  printf '  %-18s %s\n' "HTTPS" "Caddy, certificates for: $hosts"
else
  printf '  %-18s %s\n' "HTTPS" "your proxy → http://127.0.0.1:$APP_PORT"
fi
if [ "$STORAGE" = s3 ]; then
  printf '  %-18s %s\n' "Storage" "S3 bucket $S3_BUCKET${S3_ENDPOINT:+ at $S3_ENDPOINT}"
else
  printf '  %-18s %s\n' "Storage" "${MODLIGHT_DATA:-Docker volume \"appdata\"}"
fi
printf '  %-18s %s\n' "Upload limit" "$(human "$MAX_UPLOAD_BYTES")"
printf '  %-18s %s\n' "Quota per account" "$(human "$USER_QUOTA_BYTES")"
printf '  %-18s %s\n' "Registration" "$([ "$OPEN_REGISTRATION" = yes ] && echo "open to anyone" || echo "closed (you add accounts)")"
printf '  %-18s %s\n' "Mail" "$([ "$SETUP_MAIL" = yes ] && echo "$SMTP_HOST:$SMTP_PORT ($SMTP_SECURITY), from $MAIL_FROM" || echo "not configured")"
printf '  %-18s %s\n' "Secrets" "$([ "$AUTH_NEW" = 1 ] && echo "newly generated" || echo "kept from the existing .env")"

if [ "$ASSUME_YES" != 1 ]; then
  yes_no WRITE_OK "Write $ENV_FILE?" y
  [ "$WRITE_OK" = yes ] || die "Nothing written."
fi

# ── Write .env ────────────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  backup="$ENV_FILE.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$ENV_FILE" "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  note "Previous configuration saved as $backup"
fi

umask 077
tmp=$(mktemp "$ENV_FILE.XXXXXX")
q() { env_quote "$1"; }
{
  cat <<EOF
# Modlight configuration, written by setup.sh on $(date -u +%Y-%m-%dT%H:%MZ).
# Re-run ./setup.sh to change it, or edit by hand: every variable is described
# in .env.example. After a change: docker compose up -d --build
#
# KEEP THIS FILE PRIVATE. It holds the keys that sign sessions and decrypt
# stored secrets, and the database password.

# ── Docker Compose (which files, whether the bundled Caddy runs) ────────────
COMPOSE_PATH_SEPARATOR=,
COMPOSE_FILE=$(q "$COMPOSE_FILE_VALUE")
COMPOSE_PROFILES=$(q "$COMPOSE_PROFILES_VALUE")
EOF
  [ "$PROXY" = caddy ] && printf 'CADDY_SITES=%s\n' "$(q "$hosts")"
  [ "$PROXY" = external ] && printf 'APP_PORT=%s\n' "$APP_PORT"
  cat <<EOF

# ── Addresses (baked into the build: change, then rebuild) ──────────────────
APP_URL=$(q "$APP_URL")
APP_NAME=$(q "$APP_NAME")
EOF
  [ -n "$APP_DOMAINS" ] && printf 'APP_DOMAINS=%s\n' "$(q "$APP_DOMAINS")"
  [ -n "$SHORTLINK_URL" ] && printf 'SHORTLINK_URL=%s\n' "$(q "$SHORTLINK_URL")"
  cat <<EOF
TRUST_PROXY=true

# ── Secrets: never change these on a running install ───────────────────────
AUTH_SECRET=$(q "$AUTH_SECRET")
EOF
  [ -n "$SETTINGS_ENCRYPTION_KEY" ] && printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(q "$SETTINGS_ENCRYPTION_KEY")"
  cat <<EOF
POSTGRES_PASSWORD=$(q "$POSTGRES_PASSWORD")

# ── Storage ─────────────────────────────────────────────────────────────────
STORAGE_DRIVER=$STORAGE
EOF
  if [ "$STORAGE" = local ]; then
    [ -n "$MODLIGHT_DATA" ] && printf 'MODLIGHT_DATA=%s\n' "$(q "$MODLIGHT_DATA")"
  else
    printf 'S3_ENDPOINT=%s\nS3_REGION=%s\nS3_BUCKET=%s\nS3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\nS3_FORCE_PATH_STYLE=%s\n' \
      "$(q "$S3_ENDPOINT")" "$(q "$S3_REGION")" "$(q "$S3_BUCKET")" "$(q "$S3_ACCESS_KEY_ID")" \
      "$(q "$S3_SECRET_ACCESS_KEY")" "$([ "$S3_FORCE_PATH_STYLE" = yes ] && echo true || echo false)"
  fi
  cat <<EOF

# ── Accounts and limits ─────────────────────────────────────────────────────
# REGISTRATION_ENABLED is read once, on first start; afterwards the switch
# lives in the admin panel.
REGISTRATION_ENABLED=$([ "$OPEN_REGISTRATION" = yes ] && echo true || echo false)
MAX_UPLOAD_SIZE=$MAX_UPLOAD_BYTES
DEFAULT_USER_QUOTA=$USER_QUOTA_BYTES

# ── Mail (the admin panel can override all of it) ──────────────────────────
SMTP_HOST=$(q "$SMTP_HOST")
SMTP_PORT=$(q "$SMTP_PORT")
SMTP_SECURITY=$(q "$SMTP_SECURITY")
SMTP_USER=$(q "$SMTP_USER")
SMTP_PASSWORD=$(q "$SMTP_PASSWORD")
MAIL_FROM=$(q "$MAIL_FROM")
MAIL_FROM_NAME=$(q "$MAIL_FROM_NAME")

NODE_ENV=production
EOF
} >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "${G}✓${N} Wrote $ENV_FILE"

# Storage directory on the host: the app runs as uid 1000.
if [ -n "${MODLIGHT_DATA:-}" ]; then
  if mkdir -p "$MODLIGHT_DATA" 2>/dev/null && chown 1000:1000 "$MODLIGHT_DATA" 2>/dev/null; then
    say "${G}✓${N} $MODLIGHT_DATA is ready"
  elif command -v sudo >/dev/null 2>&1 && sudo mkdir -p "$MODLIGHT_DATA" && sudo chown 1000:1000 "$MODLIGHT_DATA"; then
    say "${G}✓${N} $MODLIGHT_DATA is ready"
  else
    warn "Could not prepare $MODLIGHT_DATA. Before starting, run as root:"
    warn "  mkdir -p '$MODLIGHT_DATA' && chown 1000:1000 '$MODLIGHT_DATA'"
  fi
fi

# A ready nginx server block for the own-proxy case.
if [ "$PROXY" = external ]; then
  names=$(printf '%s' "$hosts" | tr -d ',')
  cat >"$NGINX_FILE" <<EOF
# nginx server block for Modlight, generated by setup.sh.
# Add your TLS certificate lines (or let your panel manage them), then include
# this file from nginx and reload. The three settings marked REQUIRED are what
# keeps large uploads from failing; X-Real-IP is what the rate limits trust.

server {
    listen 80;
    server_name $names;

    client_max_body_size 0;                       # REQUIRED: no size cap at the proxy

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;   # REQUIRED
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_request_buffering off;              # REQUIRED: stream uploads through
        proxy_buffering off;

        proxy_connect_timeout 60s;
        proxy_send_timeout    3600s;
        proxy_read_timeout    3600s;
        send_timeout          3600s;
    }
}
EOF
  chmod 644 "$NGINX_FILE"
  say "${G}✓${N} Wrote $NGINX_FILE (an nginx server block for your proxy)"
fi

# ── Start ─────────────────────────────────────────────────────────────────────
if [ "$HAVE_DOCKER" != 1 ]; then
  say ""
  say "Next: install Docker, then run ${B}docker compose up -d --build${N} in this directory."
  exit 0
fi

if [ "$ASSUME_YES" = 1 ] && [ -z "${START-}" ]; then START=no; fi
yes_no START "Build and start Modlight now? The first build takes a few minutes." y
if [ "$START" != yes ]; then
  say ""
  say "When you are ready: ${B}docker compose up -d --build${N}"
  exit 0
fi

docker compose up -d --build

say ""
say "Waiting for the app to report healthy…"
cid=$(docker compose ps -q app)
status=""
for _ in $(seq 1 90); do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
  [ "$status" = healthy ] && break
  [ "$status" = exited ] || [ "$status" = dead ] && break
  sleep 2
done

if [ "$status" = healthy ]; then
  say "${G}✓ Modlight is running.${N}"
  say ""
  say "  Open ${B}$APP_URL/register${N} and create your account: the first one becomes the administrator."
  if [ "$PROXY" = external ]; then
    say "  Point your proxy at http://127.0.0.1:$APP_PORT (see $NGINX_FILE)."
  else
    note "  If the page does not load yet, Caddy may still be obtaining certificates: docker compose logs caddy"
  fi
else
  warn "The app is not healthy yet (status: ${status:-unknown}). Its log:"
  docker compose logs --tail 40 app >&2 || true
  exit 1
fi
