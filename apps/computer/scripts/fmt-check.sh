#!/usr/bin/env bash
# gofmt -l exits 0 even when it lists files, so the check needs its own failure.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unformatted="$(bash "$package_dir/scripts/go.sh" gofmt -l .)"

if [ -n "$unformatted" ]; then
  echo "these files are not gofmt clean:" >&2
  echo "$unformatted" >&2
  echo "run: bun run --cwd apps/computer fmt" >&2
  exit 1
fi
