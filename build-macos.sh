#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ARCH="${1:-$(go env GOARCH)}"
case "$ARCH" in arm64|amd64) ;; *) echo "架构必须是 arm64 或 amd64" >&2; exit 1;; esac
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
(cd "$ROOT/core-go" && go test ./... && go vet ./...)
(cd "$ROOT" && node --test tests/*.test.cjs)
(cd "$ROOT/installer" && go test ./... && go vet ./...)
mkdir -p "$STAGE/installer/payload/app" "$ROOT/dist/macos-$ARCH"
cp "$ROOT/installer/"*.go "$ROOT/installer/go.mod" "$STAGE/installer/"
cp -R "$ROOT/addins" "$ROOT/samples" "$STAGE/installer/payload/app/"
cp "$ROOT/README.md" "$ROOT/CHANGE_HISTORY.md" "$ROOT/HOST_CAPABILITIES.md" "$ROOT/MACOS_VALIDATION.md" "$ROOT/JAVASCRIPT_VALIDATION.md" "$ROOT/THIRD_PARTY_NOTICES.md" "$STAGE/installer/payload/app/"
(cd "$ROOT/core-go" && GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=0 go build -trimpath -o "$STAGE/installer/payload/app/DataReportAssistantCore" .)
(cd "$STAGE/installer" && GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=0 go build -trimpath -o "$ROOT/dist/macos-$ARCH/DataReportAssistantInstaller" .)
printf '#!/bin/bash\ncd "$(dirname "$0")"\n./DataReportAssistantInstaller\nprintf "\\n按回车退出"\nread -r\n' > "$ROOT/dist/macos-$ARCH/安装.command"
chmod +x "$ROOT/dist/macos-$ARCH/安装.command"
printf '#!/bin/bash\ncd "$(dirname "$0")"\n./DataReportAssistantInstaller --uninstall\nprintf "\\n按回车退出"\nread -r\n' > "$ROOT/dist/macos-$ARCH/卸载.command"
chmod +x "$ROOT/dist/macos-$ARCH/卸载.command"
echo "macOS 安装包：$ROOT/dist/macos-$ARCH"
