#!/bin/sh
# Static release artifacts; cargo-zigbuild + Zig or cross + Docker is required.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
if command -v cargo-zigbuild >/dev/null 2>&1 && command -v zig >/dev/null 2>&1; then
  BUILDER=zigbuild
elif command -v cross >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
  BUILDER=cross
else
  echo 'Install cargo-zigbuild and Zig, or cross and Docker, to build both musl targets.' >&2
  exit 1
fi
for arch in x86_64 aarch64; do
  target="$arch-unknown-linux-musl"
  rustup target add "$target"
  if [ "$BUILDER" = zigbuild ]; then
    bash scripts/cargo.sh zigbuild --release --locked --target "$target"
  else
    cross build --release --locked --target "$target"
  fi
  case "$arch" in x86_64) name=x64 ;; aarch64) name=arm64 ;; esac
  cp "target/$target/release/agentum" "dist/agentum-linux-$name"
done
