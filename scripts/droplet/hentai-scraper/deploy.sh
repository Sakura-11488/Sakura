#!/usr/bin/env bash
#
# Deploy / update the Sakura Hentai (18+) scraper on the DigitalOcean droplet.
#
# Run on the droplet (as root) from inside this directory:
#     bash deploy.sh
#
# It will:
#   1. Install Node 20 and PM2 if missing
#   2. Copy the service into /opt/sakura/hentai-scraper (keeping secrets)
#   3. Install npm dependencies
#   4. Start (or reload) the PM2 process with a refreshed env
#   5. (Re)write the /hentai/v1/ nginx block — idempotently
#   6. Reload nginx
#   7. Gate on /readyz, which PROVES parsed data, not just liveness

set -euo pipefail

APP_DIR="/opt/sakura/hentai-scraper"
PREV_DIR="/opt/sakura/hentai-scraper.prev"
NGINX_SITE="/etc/nginx/sites-available/psyopanime"
NGINX_SNIPPET_MARKER="# >>> sakura hentai scraper >>>"
NGINX_SNIPPET_CLOSER="# <<< sakura hentai scraper <<<"
PORT="${HENTAI_SCRAPER_PORT:-3101}"

log() { printf '[hentai-deploy] %s\n' "$*"; }

ROLLED_BACK=0
rollback_app() {
    [[ "$ROLLED_BACK" == "1" ]] && return 0
    ROLLED_BACK=1
    # Never roll back to a release without the content policy: that would trade
    # a failed deploy for an unfiltered 18+ service. The new release stays up,
    # failing closed (its lists 502 rather than serve unchecked galleries).
    if [[ -d "$PREV_DIR" ]] && ! grep -q 'CONTENT_POLICY_VERSION' "$PREV_DIR/server.js" 2>/dev/null; then
        log "NOT rolling back: the release in $PREV_DIR predates the content policy."
        log "  the new release is left running; fix forward and re-run deploy.sh."
        return 0
    fi
    if [[ -d "$PREV_DIR" ]]; then
        log "ROLLING BACK to the previous release in $PREV_DIR"
        # node_modules included (npm install has already replaced them), and
        # --checksum because npm stamps every installed file with one fixed
        # mtime, so rsync's size+mtime check would skip changed files. The
        # credential files are kept as they are.
        rsync -a --delete --checksum \
            --exclude 'proxy-url*.txt' \
            --exclude 'debug-token.txt' \
            --exclude 'img-key.txt' \
            "$PREV_DIR/" "$APP_DIR/"
        (cd "$APP_DIR" && pm2 reload ecosystem.config.cjs --update-env && pm2 save) || true
        log "rolled back."
    else
        log "no snapshot at $PREV_DIR; cannot auto-roll-back."
    fi
}

# Any failure once the new release starts landing (npm install, pm2, nginx -t,
# the /readyz gate) rolls back, instead of exiting with the new code live.
RELEASE_LANDING=0
on_exit() {
    local rc=$?
    if [[ "$rc" != "0" && "$RELEASE_LANDING" == "1" ]]; then
        rollback_app
    fi
    exit "$rc"
}
trap on_exit EXIT

log "ensuring Node.js 20 is installed"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

log "ensuring PM2 is installed"
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -d "$APP_DIR" ]]; then
    log "snapshotting the current release to $PREV_DIR"
    rm -rf "$PREV_DIR"
    cp -a "$APP_DIR" "$PREV_DIR"
fi
RELEASE_LANDING=1

log "syncing source to $APP_DIR"
mkdir -p "$APP_DIR"
# The excludes matter: `--delete` would otherwise wipe the untracked credential
# files on every redeploy, and the service would silently fall back to the free
# path (or, for the sibling comics service, to unproxied 403s) while still
# reporting a healthy process. img-key.txt is the /img link-signing key the
# service creates on first start: wiping it would break every image link a
# client holds at each deploy.
rsync -a --delete \
    --exclude node_modules \
    --exclude 'proxy-url*.txt' \
    --exclude 'debug-token.txt' \
    --exclude 'img-key.txt' \
    "$SCRIPT_DIR/" "$APP_DIR/"

cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

log "starting / reloading PM2 process"
if pm2 describe sakura-hentai-scraper >/dev/null 2>&1; then
    # --update-env is required: without it pm2 reuses the environment captured at
    # first start, so every env change in ecosystem.config.cjs is silently
    # ignored — including the timeout budget this service depends on.
    pm2 reload ecosystem.config.cjs --update-env
else
    pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

NGINX_BACKUP=""
if [[ -f "$NGINX_SITE" ]]; then
    log "(re)writing the /hentai/v1/ nginx block"
    NGINX_BACKUP="${NGINX_SITE}.bak.$(date +%s)"
    cp -a "$NGINX_SITE" "$NGINX_BACKUP"
    stripped="$(mktemp)"
    # 1) Remove any previously-inserted block. The old script SKIPPED the whole
    #    patch when the marker was already present, which meant every later edit
    #    to nginx-snippet.conf was silently ignored on an already-deployed box.
    awk -v marker="$NGINX_SNIPPET_MARKER" -v closer="$NGINX_SNIPPET_CLOSER" '
        index($0, marker) == 1 { skip = 1; next }
        index($0, closer) == 1 { skip = 0; next }
        !skip { print }
    ' "$NGINX_SITE" > "$stripped"

    tmp="$(mktemp)"
    # 2) Insert before the LAST top-level `}` — the closing brace of the server
    #    block — so the new location {} lands inside server {}.
    #
    #    Not the *first* such brace: every snippet these deploy scripts add
    #    brings its own column-0 `}`, so once a sibling scraper is installed the
    #    first top-level brace is that sibling's location block, and anchoring
    #    there nests the new location inside it. nginx then refuses to load with
    #    'location "/x/v1/" is outside location "/y/v1/"'.
    awk -v marker="$NGINX_SNIPPET_MARKER" \
        -v closer="$NGINX_SNIPPET_CLOSER" \
        -v snippet="$SCRIPT_DIR/nginx-snippet.conf" '
        { lines[NR] = $0; if ($0 ~ /^}[[:space:]]*$/) last = NR }
        END {
            if (last == 0) { exit 3 }
            for (i = 1; i <= NR; i++) {
                if (i == last) {
                    print marker
                    while ((getline line < snippet) > 0) print line
                    close(snippet)
                    print closer
                }
                print lines[i]
            }
        }
    ' "$stripped" > "$tmp" || {
        rm -f "$tmp" "$stripped"
        log "ERROR: no top-level '}' found in $NGINX_SITE — patch it by hand"
        exit 1
    }
    mv "$tmp" "$NGINX_SITE"
    rm -f "$stripped"
fi

log "testing & reloading nginx"
# The app rollback does not cover nginx: on a failed test, put the site file
# back, or the next reload by anyone (a sibling deploy, certbot) fails on it.
if ! nginx -t; then
    if [[ -n "$NGINX_BACKUP" ]]; then
        log "nginx -t failed; restoring $NGINX_SITE from $NGINX_BACKUP"
        cp -a "$NGINX_BACKUP" "$NGINX_SITE"
    fi
    exit 1
fi
systemctl reload nginx

log "confirming the live nginx timeout can outlast our retry budget"
grep -A14 'location /hentai/v1/' "$NGINX_SITE" | grep -m1 proxy_read_timeout || true

# /healthz only proves the process is up. That is exactly what hid the
# Cloudflare block: green check, dead path. Gate on /readyz, which parses a real
# listing AND derives real page URLs from a real gallery.
log "verifying the READ PATH via /readyz"
for i in $(seq 1 12); do
    if out="$(curl -sf --max-time 30 "http://127.0.0.1:${PORT}/readyz")"; then
        log "READY: $out"
        exit 0
    fi
    sleep 2
done

log "ERROR: /readyz did not pass — the process may be up while the upstream path is dead."
log "  curl -s http://127.0.0.1:${PORT}/readyz | head -c 500"
log "  curl -s http://127.0.0.1:${PORT}/healthz | head -c 500"
log "  pm2 logs sakura-hentai-scraper --lines 60 --nostream"
exit 1
