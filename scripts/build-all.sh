#!/usr/bin/env bash
# Compile claude-statusline pour toutes les plateformes cibles.
# Bun cross-compile depuis n'importe quel hôte (ex. CI Ubuntu → tout).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

# target Bun                → nom de l'asset (doit matcher install.sh)
targets=(
  "bun-linux-x64:claude-statusline-linux-x64"
  "bun-linux-arm64:claude-statusline-linux-arm64"
  "bun-darwin-x64:claude-statusline-darwin-x64"
  "bun-darwin-arm64:claude-statusline-darwin-arm64"
  "bun-windows-x64:claude-statusline-windows-x64.exe"
)

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  outfile="dist/${entry##*:}"
  echo "→ $target → $outfile"
  bun build --compile --target="$target" ./statusline.ts --outfile "$outfile"
done

echo "✅ Binaires dans dist/"
ls -la dist/
