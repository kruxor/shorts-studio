#!/usr/bin/env bash
# Root steps to serve Shorts Studio at shorts.kruxor.com on nerd4.
#
# Prerequisites, in this order:
#   1. DNS: an A record for shorts.kruxor.com -> 198.23.138.26, DNS-only
#      (grey cloud). Proxied would put Cloudflare between certbot and the
#      origin and HTTP-01 validation gets awkward; api.kruxor.com is DNS-only
#      for the same reason.
#   2. Files: ./deploy/publish.sh already run from the workstation.
#
# Then, as root on nerd4:
#   sudo bash nerd4-setup.sh
#
# It is idempotent: re-running rewrites the vhost and reloads nginx.
set -euo pipefail

DOMAIN=shorts.kruxor.com
WEB_ROOT=/var/www/html/shorts.kruxor.com
CONF=/etc/nginx/sites-available/$DOMAIN

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

if [ ! -f "$WEB_ROOT/index.html" ]; then
  echo "$WEB_ROOT/index.html is missing - publish the files first" >&2
  exit 1
fi

cat > "$CONF" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name shorts.kruxor.com;

    root /var/www/html/shorts.kruxor.com;
    index index.html;
    charset utf-8;

    client_max_body_size 1024m;

    # A first visit pulls ~112 MB (77 MB weights + 35 MB ONNX runtime).
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types application/javascript application/json application/wasm text/css text/plain image/svg+xml;

    # mime.types has no .mjs entry. Without this the app is silently dead: the
    # browser refuses a module script served as octet-stream, app.js never runs,
    # and drag/drop plus the file picker stop working with only a console line
    # about a "JavaScript-or-Wasm module script" to show for it.
    location ~* \.mjs$ {
        default_type application/javascript;
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    # Weights and runtime are pinned per build. immutable means browsers stop
    # revalidating, so replacing a model or runtime file means bumping its
    # directory name (whisper-base.en-v2, ort-v2).
    location ~* ^/(models|vendor)/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location ~* ^/assets/.*\.(ttf|otf|woff2|png|jpg|svg)$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # App code changes every release: revalidate so updates land at once.
    location ~* \.(html|js|mjs|css)$ {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
NGINX

ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t
systemctl reload nginx
echo "http vhost live"

# Certbot needs the name to resolve to this host, or HTTP-01 fails.
if ! getent hosts "$DOMAIN" >/dev/null; then
  echo "DNS for $DOMAIN does not resolve yet; skipping TLS. Re-run after the A record is added." >&2
  exit 0
fi

echo "requesting certificate..."
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos
systemctl reload nginx
echo "https live: https://$DOMAIN/"
