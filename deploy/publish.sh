#!/usr/bin/env bash
# Publish public/ to the Shorts Studio web root. No build step, no bundler.
#
#   ./deploy/publish.sh                 # to nerd4 (default)
#   TARGET=other REMOTE_DIR=/path ./deploy/publish.sh
#
# public/models/ is gitignored, so it only ever travels this way. 77 MB of
# weights move on the first run and are unchanged afterwards.
set -euo pipefail

TARGET=${TARGET:?set TARGET to an ssh host, e.g. TARGET=web1}
REMOTE_DIR=${REMOTE_DIR:-/var/www/html/shorts.kruxor.com}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

test -f "$HERE/public/index.html" || { echo "run from the repo; public/index.html not found" >&2; exit 1; }
test -d "$HERE/public/models/whisper-base.en" || { echo "models missing - run ./scripts/fetch-models.sh first" >&2; exit 1; }

echo "publishing $HERE/public -> $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete --info=progress2 "$HERE/public/" "$TARGET:$REMOTE_DIR/"
echo "done. verify with:"
echo "  E2E_URL=https://shorts.kruxor.com/ node tests/e2e/vhost-boot.mjs"
