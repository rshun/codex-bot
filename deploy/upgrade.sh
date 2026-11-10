#!/bin/sh
# Replace the installed amd64 binary with the latest GitHub release and restart.
set -eu
repo="${REPO:-rshun/codex-bot}"
dest="${DEST:-/usr/local/bin/codex-bot}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
gh release download --repo "$repo" --pattern codex-bot --output "$tmp"
install -m 0755 "$tmp" "$dest"
systemctl restart codex-bot
systemctl --no-pager --lines=20 status codex-bot
