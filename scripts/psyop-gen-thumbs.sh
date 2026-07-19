#!/bin/bash
for f in /var/www/psyopanime/videos/*.mp4; do
  id=$(basename "$f" .mp4)
  jpg="/var/www/psyopanime/thumbs/${id}.jpg"
  if [ ! -s "$jpg" ]; then
    ffmpeg -y -ss 2 -i "$f" -vframes 1 -q:v 2 "$jpg" 2>/dev/null
    echo "thumb $id"
  fi
done
echo "thumbs: $(ls /var/www/psyopanime/thumbs/*.jpg | wc -l)"
