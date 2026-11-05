#!/bin/sh
set -eu
if ! command -v cargo >/dev/null 2>&1; then
  echo 'cargo is not installed; skipping Rust checks (install stable Rust with rustup).'
  exit 0
fi
cd "$(dirname "$0")/.."
mkdir -p target/tmp
export TMPDIR="$PWD/target/tmp"
exec cargo "$@"
