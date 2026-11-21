#!/usr/bin/env bash
# Build Black-Hole Break from source and install it in VS Code (macOS / Linux).
# Needs: Node.js 18+ (npx) and the VS Code `code` command on PATH.
set -euo pipefail

cd "$(dirname "$0")/black-hole-break"

if ! command -v code >/dev/null 2>&1; then
  echo "The 'code' command is not on PATH."
  echo "In VS Code: Cmd+Shift+P (Ctrl+Shift+P) > 'Shell Command: Install 'code' command in PATH'. Then run this script again."
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "Node.js is necessary (npx not found). Install it from https://nodejs.org and run this script again."
  exit 1
fi

echo "==> Run the tests"
npm test --silent

echo "==> Build the extension package"
rm -f black-hole-break-*.vsix
npx --yes @vscode/vsce package
VSIX="$(ls -t black-hole-break-*.vsix | head -1)"

echo "==> Remove the old Dust Break extension (if installed)"
code --uninstall-extension local-dev.dust-break >/dev/null 2>&1 || true

echo "==> Install ${VSIX}"
code --install-extension "${VSIX}" --force
rm -f "${VSIX}"

echo
echo "Done. In VS Code: Cmd+Shift+P (Ctrl+Shift+P) > 'Developer: Reload Window'."
echo "Then try: 'Black-Hole Break: Take a Break Now'."
