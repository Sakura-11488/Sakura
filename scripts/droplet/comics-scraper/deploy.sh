#!/usr/bin/env bash
#
# Deploy / update the Sakura Comics scraper on the DigitalOcean droplet.
#
# Run on the droplet (as root) from inside this directory:
#     bash deploy.sh
#
# It will:
#   1. Install Node 20 and PM2 if missing
#   2. SNAPSHOT the current release so a failed gate can be undone
#   3. Copy the service into /opt/sakura/comics-scraper (keeping secrets)
#   4. Install npm dependencies
#   5. Start (or reload) the PM2 process with a REFRESHED env
#   6. (Re)write the /comics/v1/ nginx block — idempotently, and safely on a box
#      where the existing block has no markers
#   7. Test and reload nginx, restoring the backup if the test fails
#   8. Gate on /readyz (which PROVES parsed data) AND on the nginx route, and
#      ROLL BACK the app to the snapshot if the gate fails
#
# Dry-run the nginx rewrite before trusting it on a shared server block:
#     cp /etc/nginx/sites-available/psyopanime /tmp/ng.test
#     NGINX_SITE=/tmp/ng.test DRY_RUN=1 bash deploy.sh   # then diff /tmp/ng.test

set -euo pipefail

APP_DIR="/opt/sakura/comics-scraper"
PREV_DIR="/opt/sakura/comics-scraper.prev"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/psyopanime}"
NGINX_SNIPPET_MARKER="# >>> sakura comics scraper >>>"
NGINX_SNIPPET_CLOSER="# <<< sakura comics scraper <<<"
PORT="${COMICS_SCRAPER_PORT:-3100}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[comics-deploy] %s\n' "$*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rollback_app() {
    if [[ -d "$PREV_DIR" ]]; then
        log "ROLLING BACK to the previous release in $PREV_DIR"
        rsync -a --delete \
            --exclude 'proxy-template*.txt' \
            --exclude 'image-proxy-template*.txt' \
            --exclude 'debug-token.txt' \
            --exclude img-cache \
            "$PREV_DIR/" "$APP_DIR/"
        (cd "$APP_DIR" && pm2 reload ecosystem.config.cjs --update-env) || true
        log "rolled back. nginx was NOT reverted — see the backup path printed above."
    else
        log "no snapshot at $PREV_DIR; cannot auto-roll-back."
    fi
}

if [[ "$DRY_RUN" != "1" ]]; then
    log "ensuring Node.js 20 is installed"
    if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi

    log "ensuring PM2 is installed"
    if ! command -v pm2 >/dev/null 2>&1; then
        npm install -g pm2
    fi

    # A snapshot is the only rollback that exists on this box: there is no git
    # checkout of the repo on the droplet, so "git checkout && redeploy" means
    # re-transferring files from a Windows dev machine while the tab is down.
    if [[ -d "$APP_DIR" ]]; then
        log "snapshotting the current release to $PREV_DIR"
        rm -rf "$PREV_DIR"
        cp -a "$APP_DIR" "$PREV_DIR"
    fi

    log "syncing source to $APP_DIR"
    mkdir -p "$APP_DIR"
    # The excludes matter: `--delete` would otherwise wipe the untracked
    # credential files on every redeploy, silently removing the Cloudflare
    # fallback (and the disk image cache, which is worth real money — it is the
    # only thing that keeps a proxied image from being paid for twice).
    rsync -a --delete \
        --exclude node_modules \
        --exclude 'proxy-template*.txt' \
        --exclude 'image-proxy-template*.txt' \
        --exclude 'debug-token.txt' \
        --exclude img-cache \
        "$SCRIPT_DIR/" "$APP_DIR/"

    cd "$APP_DIR"

    log "installing dependencies"
    npm install --omit=dev --no-audit --no-fund

    log "starting / reloading PM2 process"
    if pm2 describe sakura-comics-scraper >/dev/null 2>&1; then
        # --update-env is REQUIRED. Without it pm2 reuses the environment
        # captured at first start, so every env change in ecosystem.config.cjs is
        # silently ignored — including the timeouts and the proxy templates. This
        # service was reloading without it, which is why toggling a template on
        # disk appeared to do nothing.
        pm2 reload ecosystem.config.cjs --update-env
    else
        pm2 start ecosystem.config.cjs
    fi
    pm2 save
    pm2 startup systemd -u root --hp /root >/dev/null || true
fi

if [[ -f "$NGINX_SITE" ]]; then
    # The insert below anchors on the LAST column-0 `}`, which is correct ONLY
    # while this file holds exactly one server block. The presence of
    # psyopanime.pre-tls.bak on this box proves the TLS layout has been edited
    # before; if a redirect/TLS server{} is ever appended, the comics location
    # would silently land in the wrong one and `nginx -t` would still pass.
    SERVERS="$(grep -c '^server {' "$NGINX_SITE" || true)"
    if [[ "$SERVERS" != "1" ]]; then
        log "ERROR: expected exactly one top-level 'server {' in $NGINX_SITE, found $SERVERS."
        log "       The insert anchor is not safe here. Patch the block by hand."
        exit 1
    fi

    log "(re)writing the /comics/v1/ nginx block"
    BACKUP="${NGINX_SITE}.bak.$(date +%s)"
    cp -a "$NGINX_SITE" "$BACKUP"

    stripped="$(mktemp)"
    # 1) Remove any previously-inserted MARKED block.
    awk -v marker="$NGINX_SNIPPET_MARKER" -v closer="$NGINX_SNIPPET_CLOSER" '
        index($0, marker) == 1 { skip = 1; next }
        index($0, closer) == 1 { skip = 0; next }
        !skip { print }
    ' "$NGINX_SITE" > "$stripped"

    stripped2="$(mktemp)"
    # 2) Remove any UNMARKED `location [=] /comics/v1/...` block by BRACE
    #    MATCHING.
    #
    #    This step is why this script cannot just copy the sibling hentai
    #    deploy. The comics block was installed by the ORIGINAL version of this
    #    script, which inserted it with no markers at all — verified on the live
    #    box: `grep -c "sakura comics scraper" $NGINX_SITE` -> 0. Step 1 would
    #    therefore strip nothing, step 3 would append a second
    #    `location /comics/v1/`, and `nginx -t` would fail with a duplicate
    #    location — taking nginx down for EVERY service on the droplet, not just
    #    comics. Handles the nested `if () { }` inside the block.
    awk '
        !skipping && $0 ~ /^[[:space:]]*location[[:space:]]*=?[[:space:]]*\/comics\/v1\// {
            skipping = 1
            depth = gsub(/\{/, "{") - gsub(/\}/, "}")
            if (depth <= 0) skipping = 0
            next
        }
        skipping {
            depth += gsub(/\{/, "{") - gsub(/\}/, "}")
            if (depth <= 0) skipping = 0
            next
        }
        { print }
    ' "$stripped" > "$stripped2"

    tmp="$(mktemp)"
    # 3) Insert before the LAST top-level `}` — the closing brace of the server
    #    block — so the new location {} lands inside server {}.
    #
    #    Not the *first* such brace: every snippet these deploy scripts add
    #    brings its own column-0 `}`, so once a sibling scraper is installed the
    #    first top-level brace is that sibling's location block, and anchoring
    #    there nests the new location inside it. nginx then refuses to load with
    #    'location "/comics/v1/" is outside location "/hentai/v1/"'.
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
    ' "$stripped2" > "$tmp" || {
        rm -f "$tmp" "$stripped" "$stripped2"
        log "ERROR: no top-level '}' found in $NGINX_SITE — patch it by hand"
        exit 1
    }
    mv "$tmp" "$NGINX_SITE"
    rm -f "$stripped" "$stripped2"

    if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN: rewrote $NGINX_SITE only. Diff it against $BACKUP and stop here."
        exit 0
    fi

    log "testing nginx config"
    if ! nginx -t; then
        log "ERROR: nginx -t FAILED — restoring $BACKUP and leaving nginx untouched"
        cp -a "$BACKUP" "$NGINX_SITE"
        nginx -t
        rollback_app
        exit 1
    fi
    systemctl reload nginx
    log "nginx reloaded (backup kept at $BACKUP)"
fi

log "confirming the live nginx timeout can outlast our budget (want >= 25s)"
grep -A20 'location /comics/v1/' "$NGINX_SITE" | grep -m1 proxy_read_timeout || true

# /healthz only proves the process is up. That is exactly what hid the reader
# outage for three weeks: green check, every page image 404ing. Gate on /readyz,
# which walks list -> details -> chapters -> pages -> LIVE IMAGE BYTES.
#
# /readyz is single-flight in the service, so this loop cannot stack concurrent
# walks; --max-time is set above a full walk's worst case for the same reason.
log "verifying the READ PATH via /readyz (127.0.0.1, nginx denies it publicly)"
READY_OUT=""
READY_OK=0
for _ in $(seq 1 10); do
    if READY_OUT="$(curl -sf --max-time 45 "http://127.0.0.1:${PORT}/readyz")"; then
        READY_OK=1
        break
    fi
    sleep 3
done

if [[ "$READY_OK" != "1" ]]; then
    log "ERROR: /readyz did not pass."
    log "  curl -s http://127.0.0.1:${PORT}/readyz  | head -c 800"
    log "  curl -s http://127.0.0.1:${PORT}/healthz | head -c 800"
    log "  pm2 logs sakura-comics-scraper --lines 60 --nostream"
    rollback_app
    exit 1
fi
log "READY: $READY_OUT"

# The nginx rewrite is the riskiest step and was previously the only unverified
# one — the old gate polled 127.0.0.1:3100 and never touched the route it had
# just rewritten.
log "verifying the nginx route"
if ! curl -sf --max-time 10 "http://127.0.0.1/comics/v1/healthz" >/dev/null; then
    log "ERROR: /comics/v1/healthz is not reachable through nginx — the location block is wrong."
    log "       restore with: cp -a ${BACKUP:-<backup>} $NGINX_SITE && nginx -t && systemctl reload nginx"
    rollback_app
    exit 1
fi
log "nginx route OK"

case "$READY_OUT" in
    *'"degraded":true'*)
        log ""
        log "  ############################################################"
        log "  # WARNING: browse works, CHAPTER READING DOES NOT.         #"
        log "  # Page images return no bytes. This is an upstream outage  #"
        log "  # (reproduced from the droplet, from a residential IP, and #"
        log "  # through ZenRows) — not something this deploy caused and  #"
        log "  # not something a proxy can fix.                           #"
        log "  # When the source restores page images, set                #"
        log "  #   COMICS_READY_REQUIRE_IMAGE=1                           #"
        log "  # so this becomes a hard deploy gate.                      #"
        log "  ############################################################"
        ;;
esac
exit 0
