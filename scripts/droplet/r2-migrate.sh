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
# RUN ON THE DROPLET (as root) VIA THE WRAPPER, which prompts for the
# credentials instead of taking them from a command line:
#
#     tmux new -s r2
#     bash /root/r2-run.sh
#
# Do NOT start this script with `export R2_SECRET_ACCESS_KEY=...` — that line
# lands in /root/.bash_history in plaintext. r2-run.sh reads it with `read -rs`
# so it never reaches history, argv, or disk. See that script's header.
#
# This script itself takes its credentials from the environment:
#     R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
# and DRY_RUN=1 to see what would move. Nothing is written to disk and nothing
# is ever echoed.
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

# Deliberately NOT auto-installing. This used to run
#     curl -fsSL https://rclone.org/install.sh | bash
# as root, at a point where the live R2 secret is already exported into the
# environment that child inherits — piping a remote script to a root shell and
# handing it a production credential. rclone v1.75.0 is already installed here;
# if it ever is not, installing it is a deliberate, separate act.
command -v rclone >/dev/null 2>&1 \
  || die "rclone is not installed. Install it first: apt install rclone (or see rclone.org/install)"
log "rclone $(rclone version | head -1 | awk '{print $2}')"

# The remote is defined ENTIRELY by RCLONE_CONFIG_R2_* environment variables,
# so the secret never touches disk.
#
# This replaced a 0600 mktemp config removed in an EXIT trap. That was fine
# until it wasn't: /tmp on this droplet is ext4 on /dev/vda1, not tmpfs, so the
# file was a real persistent write — and an EXIT trap does not run on SIGKILL.
# On a 1GB box the OOM killer is a live possibility during a long upload, and
# the surviving file would hold the key in plaintext until someone noticed.
#
# Verified on rclone v1.75.0: with --config /dev/null an env-var remote resolves
# and issues real S3 calls, while an undefined remote fails with "didn't find
# section in config file". The definition genuinely comes from the environment.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACL=private
# R2 ignores storage classes; setting none avoids rclone sending a header it rejects.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# /dev/null, not the default path: without it rclone would still read
# ~/.config/rclone/rclone.conf and a stale [r2] section there would silently
# win over the environment.
#
# Chunk size and upload concurrency are deliberately small. rclone holds
# chunk-size x upload-concurrency x transfers in RAM: at the previous
# 32M x 2 x 3 that was 192 MiB against ~368MB available on this 961MB box, and
# an OOM kill is one of the few ways to lose the run outright. 16M x 1 x 3 is
# 48 MiB. R2's multipart minimum is 5 MiB, and even at 16M the whole catalogue
# is ~360 parts — nowhere near the 1M Class A free-tier allowance.
RCLONE_OPTS=(--config /dev/null --transfers "$TRANSFERS" --checkers 4
             --s3-chunk-size 16M --s3-upload-concurrency 1
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
  # RCLONE_OPTS is passed here on purpose. It used to be omitted, which meant
  # this phase silently ran at rclone's DEFAULT 8 checkers while re-downloading
  # all 5.57 GiB — on a 1 vCPU box with ~368MB available that is serving live
  # traffic. The copy phase throttles to 3 transfers specifically to avoid
  # degrading the app; verification was undoing that for hours.
  #
  # Output is NOT piped through `tail` any more either: tail buffers until the
  # process exits, so a multi-hour verify printed nothing at all and read as a
  # hang. --stats-one-line gives a progress line instead.
  if ! rclone check "$src" "r2:${BUCKET}/${dest}" \
        --include '*.mp4' --include '*.mov' --include '*.webm' \
        --one-way --download "${RCLONE_OPTS[@]}"; then
    FAILED=1
  fi
done

if [[ "$FAILED" == "1" ]]; then
  die "verification FAILED — do not switch the app over until this passes"
fi

log ""
# An interrupted multipart upload leaves parts behind that DO consume storage
# but do NOT appear in a bucket listing — so the free tier can be eaten by
# something you cannot see. Every killed run leaves more. Opt-in rather than
# automatic: it is the user's bucket, and abort is not reversible.
if [[ "${CLEANUP_ORPHANS:-0}" == "1" ]]; then
  log "  aborting incomplete multipart uploads older than 24h"
  rclone backend cleanup "r2:${BUCKET}" --config /dev/null || log "  (cleanup skipped)"
else
  log "  If earlier runs were interrupted, invisible partial uploads may be"
  log "  billing against storage. Clear them with:"
  # Via the wrapper, not this script directly: run standalone it would die on
  # the missing credentials, which is the whole reason the wrapper exists.
  log "      CLEANUP_ORPHANS=1 bash /root/r2-run.sh"
  log ""
fi
log "  Upload verified. The app still points at the droplet."
log "  To cut over, set on the web build and rebuild:"
log "      EXPO_PUBLIC_R2_MEDIA_BASE=https://<your-r2-public-host>"
log "  Roll back by unsetting it and rebuilding. Nothing else changes."
log ""
log "  Keep the droplet copies until the switch has been live for a while —"
log "  they are the fallback, and deleting them is a separate decision."
