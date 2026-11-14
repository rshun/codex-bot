#!/bin/sh
# Download, SHA-256 verify, back up, and replace the installed codex-bot binary, then restart systemd.
set -eu

repo="${REPO:-rshun/codex-bot}"
dest="${DEST:-/usr/local/bin/codex-bot}"

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) asset="codex-bot-linux-amd64" ;;
  aarch64|arm64) asset="codex-bot-linux-arm64" ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

base_url="https://github.com/${repo}/releases/latest/download"
dest_dir="$(dirname "$dest")"
staged="${dest_dir}/.codex-bot.upgrade.new"
sums_file="${dest_dir}/.codex-bot.SHA256SUMS"

curl -fsSL "${base_url}/SHA256SUMS" -o "$sums_file"
curl -fsSL "${base_url}/${asset}" -o "$staged"
chmod 0755 "$staged"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*"name { print $1; exit }' "$sums_file")"
if [ -z "$expected" ]; then
  echo "Checksum entry for ${asset} not found in SHA256SUMS" >&2
  exit 1
fi

actual="$(sha256sum "$staged" | awk '{ print $1 }')"
if [ "$expected" != "$actual" ]; then
  echo "SHA-256 mismatch: expected ${expected}, got ${actual}" >&2
  exit 1
fi

"$staged" --version >/dev/null

if [ -f "$dest" ]; then
  cp -p "$dest" "${dest}.prev"
fi
mv -f "$staged" "$dest"

systemctl restart codex-bot
systemctl --no-pager --lines=20 status codex-bot
