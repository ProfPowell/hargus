#!/bin/sh
# Download axe-core into the extension so the "axe-core audit" plugin can inject it.
# axe-core is MPL-2.0 (https://github.com/dequelabs/axe-core). Usage: sh scripts/vendor-axe.sh [version]
set -e
VERSION="${1:-4.13.0}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/extension/plugins/vendor"
mkdir -p "$DIR"
curl -fsSL "https://cdn.jsdelivr.net/npm/axe-core@${VERSION}/axe.min.js" -o "$DIR/axe.min.js"
echo "axe-core ${VERSION} → $DIR/axe.min.js"
echo "Reload the extension (chrome://extensions) and enable 'axe-core audit' in Options."
