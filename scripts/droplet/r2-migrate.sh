#!/usr/bin/env bash
#
# Migrate Sakura Originals video from the droplet to Cloudflare R2.
#
# WHY: the droplet is a 1GB box whose single nginx worker fronts nine locations,
# and on web every byte is metered twice by Vercel (Fast Origin Transfer in,
# Fast Data Transfer out). R2 egress to the internet is free, and the browser
# fetches objects directly with native CORS and Range — which also removes
# Vercel's 10MB cacheable-response ceiling and its function duration limit.
#
# RUN ON THE DROPLET (as root):
#     export R2_ACCOUNT_ID=...        # Cloudflare account id
#     export R2_ACCESS_KEY_ID=...     # R2 API token: Object Read & Write
#     export R2_SECRET_ACCESS_KEY=...
#     export R2_BUCKET=sakura-media
#     bash r2-migrate.sh              # add DRY_RUN=1 to see what would move
#
# Credentials are read from the environment only. Nothing is written to disk
# outside a 0600 rclone config, and nothing is ever echoed.
#
# Idempotent and resumable: rclone skips objects whose size and modtime already
# match, so a killed run is resumed by re-running it.

set -euo pipefail

BUCKET="${R2_BUCKET:-sakura-media}"
DRY_RUN="${DRY_RUN:-0}"
# Transfers kept low on purpose: this box has 1 vCPU and is serving live
# traffic. The upload is not the urgent thing; not degrading the app is.
TRANSFERS="${TRANSFERS:-3}"

# Source dirs -> object key prefixes. The key MIRRORS the droplet path exactly,
# so lib/r2-media.ts can rewrite a URL by swapping the origin and nothing else,
# and any object can be compared against its origin by eye.
declare -A PATHS=(
  ["/var/www/psyopanime/videos"]="psyopanime/videos"
  ["/var/www/html/2heanime/videos"]="2heanime/videos"
  ["/var/www/html/sakura-originals"]="sakura-originals"
)

log() { printf '[r2-migrate] %s\n' "$*"; }
die() { printf '[r2-migrate] ERROR: %s\n' "$*" >&2; exit 1; }

for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [[ -n "${!v:-}" ]] || die "$v is not set. See the header of this script."
done

if ! command -v rclone >/dev/null 2>&1; then
  log "installing rclone"
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null 2>&1 \
    || die "rclone install failed; install it manually and re-run"
fi
log "rclone $(rclone version | head -1 | awk '{print $2}')"

# 0600, and removed on exit however we leave.
CONF="$(mktemp)"
chmod 600 "$CONF"
cleanup() { rm -f "$CONF"; }
trap cleanup EXIT

cat > "$CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
# R2 ignores storage classes; setting none avoids rclone sending a header it rejects.
no_check_bucket = true
EOF

RCLONE_OPTS=(--config "$CONF" --transfers "$TRANSFERS" --checkers 4
             --s3-chunk-size 32M --s3-upload-concurrency 2
             --stats 20s --stats-one-line --low-level-retries 10 --retries 3)
[[ "$DRY_RUN" == "1" ]] && RCLONE_OPTS+=(--dry-run)

log "bucket: ${BUCKET}   dry-run: ${DRY_RUN}   transfers: ${TRANSFERS}"

TOTAL_FILES=0
for src in "${!PATHS[@]}"; do
  [[ -d "$src" ]] || { log "SKIP (missing): $src"; continue; }
  dest="${PATHS[$src]}"
  n=$(find "$src" -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm' \) | wc -l)
  TOTAL_FILES=$((TOTAL_FILES + n))
  log "copying $n video file(s): $src  ->  r2:${BUCKET}/${dest}"
  # copy, not sync: sync would DELETE anything in the bucket that is not on the
  # droplet, which is the wrong default when the bucket may already hold objects
  # from a partial or prior run.
  rclone copy "$src" "r2:${BUCKET}/${dest}" \
    --include '*.mp4' --include '*.mov' --include '*.webm' \
    "${RCLONE_OPTS[@]}"
done

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run complete — nothing uploaded"
  exit 0
fi

# Verify by CHECKSUM, not size. A truncated upload can match on size when the
# multipart tail is lost; only a hash proves the bytes arrived.
log "verifying ${TOTAL_FILES} object(s) by checksum"
FAILED=0
for src in "${!PATHS[@]}"; do
  [[ -d "$src" ]] || continue
  dest="${PATHS[$src]}"
  if ! rclone check "$src" "r2:${BUCKET}/${dest}" \
        --include '*.mp4' --include '*.mov' --include '*.webm' \
        --config "$CONF" --one-way --download 2>&1 | tail -5; then
    FAILED=1
  fi
done

if [[ "$FAILED" == "1" ]]; then
  die "verification FAILED — do not switch the app over until this passes"
fi

log ""
log "  Upload verified. The app still points at the droplet."
log "  To cut over, set on the web build and rebuild:"
log "      EXPO_PUBLIC_R2_MEDIA_BASE=https://<your-r2-public-host>"
log "  Roll back by unsetting it and rebuilding. Nothing else changes."
log ""
log "  Keep the droplet copies until the switch has been live for a while —"
log "  they are the fallback, and deleting them is a separate decision."
