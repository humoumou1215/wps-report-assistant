#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCH="${1:-$(go env GOARCH)}"
case "$ARCH" in arm64|amd64) ;; *) echo "架构必须是 arm64 或 amd64" >&2; exit 1;; esac
exec python3 "$ROOT/scripts/build-release.py" "macos-$ARCH"
