set -e
mkdir -p /var/www/degegen-files/videos /var/www/degegen-files/thumbs /var/www/degegen-files/meta
if [ -f /root/degenupload/inverse-vibe.mp4 ]; then
  mv -f /root/degenupload/inverse-vibe.mp4 /var/www/degegen-files/videos/inverse-vibe.mp4
fi
chmod 644 /var/www/degegen-files/videos/inverse-vibe.mp4
cat > /var/www/degegen-files/meta/series.json <<'JSON'
{
  "id": "degegen-files",
  "title": "Degegen Files",
  "status": "Ongoing",
  "description": "A weekly Sakura Original series following crypto culture, hype cycles, and inverse vibes from the trenches.",
  "episodes": [
    {
      "id": "degegen-inverse-vibe",
      "number": 1,
      "title": "Inverse Vibe",
      "video": "http://165-232-83-159.nip.io/degegen-files/videos/inverse-vibe.mp4"
    }
  ]
}
JSON
if ! grep -q 'location /degegen-files/' /etc/nginx/sites-available/psyopanime; then
  python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/psyopanime')
s = p.read_text()
block = '''

    location /degegen-files/ {
        alias /var/www/degegen-files/;
        autoindex off;
        add_header Access-Control-Allow-Origin *;
        add_header Accept-Ranges bytes;
    }
'''
idx = s.rfind('\n}')
if idx == -1:
    raise SystemExit('could not find server block end')
p.write_text(s[:idx] + block + s[idx:])
PY
fi
nginx -t
systemctl reload nginx
ls -lh /var/www/degegen-files/videos/inverse-vibe.mp4
