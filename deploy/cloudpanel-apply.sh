#!/usr/bin/env bash
# Apply the MIME and cache rules CloudPanel's default static vhost gets wrong.
# Run as root ON THE SERVER, after the files have been published:
#
#   sudo bash cloudpanel-apply.sh [shorts.kruxor.com]
#
# Why this exists: a stock CloudPanel static vhost serves .mjs, .wasm and .ttf as
# application/octet-stream and expires app.js for ten years. The first makes the
# app boot dead (the browser refuses a module script with a non-JS type, so no
# listener is ever attached); the second means a release never reaches a
# returning visitor.
#
# It inserts its locations immediately after `server {`, so they are matched
# before CloudPanel's own `location ~* \.(js|css|...)$` block: regex locations
# are evaluated in file order and the first match wins. CloudPanel's rule is
# left in place rather than deleted, because it still serves images correctly.
#
# Idempotent: re-running replaces the managed block instead of stacking copies.
set -euo pipefail

DOMAIN=${1:-shorts.kruxor.com}
CONF="/etc/nginx/sites-enabled/${DOMAIN}.conf"
BEGIN='# BEGIN shorts-studio (managed)'
END='# END shorts-studio (managed)'

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$CONF" ] || { echo "vhost not found: $CONF" >&2; ls /etc/nginx/sites-enabled/ >&2; exit 1; }

cp -a "$CONF" "${CONF}.bak.$(date +%Y%m%d%H%M%S)"

python3 - "$CONF" "$BEGIN" "$END" <<'PY'
import re, sys

path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()

block = '''
    # BEGIN shorts-studio (managed)
    # mime.types on this host has no entry for .mjs/.wasm/.ttf, and a module
    # script served as octet-stream is refused outright: app.js never runs, so
    # drag and drop, the file picker and every button silently do nothing.
    location ~* \\.mjs$ {
        default_type application/javascript;
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    location ~* \\.wasm$ {
        default_type application/wasm;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    location ~* \\.(ttf|otf|woff2|woff)$ {
        types { font/ttf ttf; font/otf otf; font/woff2 woff2; font/woff woff; }
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # Weights and runtime are pinned per build. immutable means browsers stop
    # revalidating, so replacing a model or runtime file means bumping its
    # directory name (whisper-base.en-v2, ort-v2).
    location ~* ^/(models|vendor)/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # App code changes every release: revalidate so updates land immediately.
    location ~* \\.(html|js|css)$ {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
    # END shorts-studio (managed)
'''

# Drop our previous block if present.
text = re.sub(re.escape(begin) + r'.*?' + re.escape(end), '', text, flags=re.S)

# Insert right after the server block's opening brace.
m = re.search(r'server\s*\{', text)
if not m:
    sys.exit('no server { block found')
text = text[:m.end()] + block + text[m.end():]
open(path, 'w').write(text)
print(f'inserted managed block into {path}')
PY

nginx -t
systemctl reload nginx
echo "reloaded"

echo "--- verifying from the origin (bypasses Cloudflare) ---"
for path in /vendor/mp4-muxer.mjs /vendor/ort/ort-wasm-simd-threaded.wasm /assets/fonts/Anton-Regular.ttf /js/app.js /models/whisper-base.en/onnx/encoder_model_quantized.onnx; do
  printf '%-58s ' "$path"
  curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip' -H "Host: $DOMAIN" "http://127.0.0.1$path" \
    | grep -iE 'content-type|cache-control|content-encoding' | tr -d '\r' | tr '\n' ' '
  echo
done
