#!/bin/sh
# Download (or upgrade) the axe-core copy the "axe-core audit" plugin injects. The result is committed.
# axe-core is MPL-2.0 (https://github.com/dequelabs/axe-core). Usage: sh scripts/vendor-axe.sh [version]
set -e
VERSION="${1:-4.14.0}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/extension/plugins/vendor"
mkdir -p "$DIR"
curl -fsSL "https://cdn.jsdelivr.net/npm/axe-core@${VERSION}/axe.min.js" -o "$DIR/axe.min.js"
curl -fsSL "https://cdn.jsdelivr.net/npm/axe-core@${VERSION}/LICENSE" -o "$DIR/LICENSE-axe-core.txt"
echo "axe-core ${VERSION} -> $DIR/axe.min.js (+ LICENSE-axe-core.txt)"
