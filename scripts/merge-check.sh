#!/usr/bin/env bash
# Controller merge check, run in the main checkout after `git merge --no-ff`.
# Runs install, check, test and build. Skips the Rust daemon tests (agentum-rs)
# when the merge doesn't touch apps/agentum, because they take about a minute
# and nothing else depends on them.
# Usage: scripts/merge-check.sh [<base-ref>]   (base defaults to the main side of the latest merge commit)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-$(git log --merges -1 --format=%H)^1}"
filter=()
if git diff --quiet "$base" HEAD -- apps/agentum; then
  filter=(--filter='!agentum-rs')
  echo "merge-check: apps/agentum unchanged, skipping agentum-rs tests"
fi
bun install || exit 1
bun run check || exit 1
bunx turbo run test "${filter[@]}"; test_code=$?
echo "TEST $test_code"
bun run build; build_code=$?
echo "BUILD $build_code"
[ "$test_code" -eq 0 ] && [ "$build_code" -eq 0 ]
