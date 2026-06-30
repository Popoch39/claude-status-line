#!/usr/bin/env sh
set -eu

REPO="Popoch39/claude-status-line"

BIN_NAME="claude-statusline"
INSTALL_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows détecté : télécharge claude-statusline-windows-x64.exe depuis"
    echo "  https://github.com/$REPO/releases/latest puis lance-le avec : init"
    exit 1 ;;
  *) echo "OS non supporté : $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "Architecture non supportée : $arch" >&2; exit 1 ;;
esac

asset="${BIN_NAME}-${os}-${arch}"
url="https://github.com/$REPO/releases/latest/download/$asset"

# --- Téléchargement ----------------------------------------------------------
echo "→ Téléchargement $asset…"
mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/$BIN_NAME"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$target"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$target" "$url"
else
  echo "curl ou wget requis." >&2; exit 1
fi
chmod +x "$target"

"$target" init

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "ℹ️  Ajoute $INSTALL_DIR à ton PATH pour appeler '$BIN_NAME' directement." ;;
esac
