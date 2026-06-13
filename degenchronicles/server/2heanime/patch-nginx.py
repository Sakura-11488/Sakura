from pathlib import Path

p = Path("/etc/nginx/sites-available/psyopanime")
text = p.read_text()
if "location /2heanime/" in text:
    print("already present")
else:
    block = """
    location /2heanime/ {
        alias /var/www/html/2heanime/;
        autoindex off;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Headers * always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Accept-Ranges bytes always;
    }

    location = /2heanime.jpg {
        alias /var/www/html/2heanime.jpg;
        add_header Access-Control-Allow-Origin * always;
        add_header Accept-Ranges bytes always;
    }
"""
    marker = "    location /sakura-originals/ {"
    start = text.index(marker)
    end = text.index("    }", start) + 6
    p.write_text(text[:end] + block + text[end:])
    print("patched")
