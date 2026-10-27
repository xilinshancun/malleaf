#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
malleaf_ios_metro_port="${PASEO_PORT:-8081}"
source "$SCRIPT_DIR/dev-home.sh"
configure_dev_paseo_home "$@"
export MALLEAF_IOS_METRO_PORT="$malleaf_ios_metro_port"

exec node "$SCRIPT_DIR/paseo-ios-simulator-service.mjs"
