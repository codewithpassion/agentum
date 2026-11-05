#!/bin/sh
set -eu
if ! command -v cargo >/dev/null 2>&1; then
  echo 'cargo is not installed; skipping Rust checks (install stable Rust with rustup).'
  exit 0
fi
cd "$(dirname "$0")/.."
mkdir -p target/tmp
export TMPDIR="$PWD/target/tmp"
if [ -x /usr/bin/cc ]; then
  export CC=/usr/bin/cc
  # Rust's linker does not consult CC; bypass PATH shims for it as well.
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/cc
  export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/cc
fi
exec cargo "$@"
