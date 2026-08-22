#!/usr/bin/env bash
#
# Interactive launcher for r2-migrate.sh.
#
# WHY THIS EXISTS: the obvious way to start the migration is
#
#     export R2_SECRET_ACCESS_KEY=abc123...   # <- DON'T
#
# That line goes into /root/.bash_history verbatim, sits in the terminal
# scrollback, and is flushed to disk even when the SSH session is killed
# (bash saves history on SIGHUP). A leading space suppresses it only if
# HISTCONTROL happens to include ignorespace on this box — a mitigation that
# fails silently when you forget one keystroke is not one to guard a live key.
#
# So: the secret is read from the terminal with `read -rs`. It never appears in
# a command line, never in history, never in argv, never on disk. It lives only
# in this process's environment and its children's, readable by root alone —
# and the operator running this IS root, so that is not a boundary crossed.
#
# USAGE, on the droplet as root:
#
#     tmux new -s r2                 # so an SSH drop doesn't kill the upload
#     bash /root/r2-run.sh
#
#     # detach any time with Ctrl-b then d; come back with: tmux attach -t r2
#
# It runs a dry run first, shows you what would move, and asks before the real
# copy. Re-running after an interruption resumes — rclone skips objects whose
# size and modtime already match.

set -euo pipefail

MIGRATE="${MIGRATE_SCRIPT:-/root/r2-migrate.sh}"
[[ -f "$MIGRATE" ]] || { echo "ERROR: $MIGRATE not found" >&2; exit 1; }

# A pipe, cron job or nohup cannot answer a prompt and would otherwise hang
# forever holding a half-configured run.
[[ -t 0 ]] || { echo "ERROR: needs an interactive terminal (no pipe, no nohup)" >&2; exit 1; }

# Swallow any typeahead still buffered, so a multi-line paste cannot spill past
# the last prompt into the parent shell — where it would be executed and, if it
# carried the secret, recorded in history.
drain() { read -rt 0.1 -N 100000 _ 2>/dev/null || :; }
bail()  { echo "ERROR: $*" >&2; drain; exit 1; }

[[ -n "${TMUX:-}${STY:-}" ]] \
  || echo "  WARNING: not inside tmux/screen — an SSH drop will kill this run."

echo
echo "  Cloudflare R2 credentials — paste each value and press Enter."
echo "  The secret is not echoed, and nothing here is written to disk."
echo

read -rp  "  Account ID           : " R2_ACCOUNT_ID
read -rp  "  Access Key ID        : " R2_ACCESS_KEY_ID
read -rsp "  Secret Access Key    : " R2_SECRET_ACCESS_KEY; echo
read -rp  "  Bucket [sakura-media]: " R2_BUCKET
R2_BUCKET="${R2_BUCKET:-sakura-media}"
drain
echo

for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [[ -n "${!v}" ]] || bail "$v is empty"
done

# Shape checks, not validation — the real proof is the dry run connecting.
[[ "$R2_SECRET_ACCESS_KEY" =~ [[:space:]] ]] \
  && bail "secret contains whitespace — the paste probably grabbed extra text"
[[ "$R2_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] \
  || echo "  NOTE: account id is usually 32 hex chars; got ${#R2_ACCOUNT_ID}. Continuing."

export R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET

echo "  account ${R2_ACCOUNT_ID:0:6}...  key ${R2_ACCESS_KEY_ID:0:6}...  bucket ${R2_BUCKET}"
echo
echo "  ── DRY RUN ─────────────────────────────────────────────"
DRY_RUN=1 bash "$MIGRATE"

echo
read -rp "  Upload for real? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "  Stopped. Nothing uploaded."; drain; exit 0; }

echo
echo "  ── UPLOAD ──────────────────────────────────────────────"
bash "$MIGRATE"
