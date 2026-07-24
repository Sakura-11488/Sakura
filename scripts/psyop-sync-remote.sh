#!/bin/bash
set -euo pipefail
VIDEOS=/var/www/psyopanime/videos
THUMBS=/var/www/psyopanime/thumbs
LIST=/root/psyop-sync/missing.txt
YTDLP=/usr/local/bin/yt-dlp
[[ -x "$YTDLP" ]] || YTDLP=yt-dlp
mkdir -p "$VIDEOS" "$THUMBS" /root/psyop-sync

while IFS='|' read -r id title; do
  [[ -z "$id" ]] && continue
  mp4="$VIDEOS/${id}.mp4"
  jpg="$THUMBS/${id}.jpg"
  if [[ -f "$mp4" && $(stat -c%s "$mp4" 2>/dev/null || echo 0) -gt 100000 ]]; then
    echo "skip video $id"
  else
    echo "download $id — $title"
    # The merge branch MUST come first: yt-dlp takes the first matching branch,
    # and a leading `best[ext=mp4]` matches YouTube's only progressive mp4
    # (itag 18 = 360p), so HD was never fetched.
    "$YTDLP" --no-update \
      -f 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[ext=mp4]/best' \
      --merge-output-format mp4 -o "$mp4" "https://www.youtube.com/watch?v=$id"
    chmod 644 "$mp4"
  fi
  if [[ ! -f "$jpg" || $(stat -c%s "$jpg" 2>/dev/null || echo 0) -lt 1000 ]]; then
    echo "thumb $id"
    ffmpeg -y -ss 3 -i "$mp4" -vframes 1 -q:v 2 "$jpg" 2>/dev/null || \
      ffmpeg -y -ss 1 -i "$mp4" -vframes 1 -q:v 2 "$jpg"
    chmod 644 "$jpg"
  fi
done < "$LIST"
echo "remote sync complete"
