#!/usr/bin/env bash
# Controller merge check, run in the main checkout after `git merge --no-ff`.
# Runs install and check, then tests and builds only the packages the merge
# changed, and skips the tests of their dependencies (turbo `--only` with the `[base...HEAD]` filter). Typecheck in `bun run check` still covers dependents.
# The scripts tests run only when scripts/ changed.
# Usage: scripts/merge-check.sh [<base-ref>]   (base defaults to the main side of the latest merge commit)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-$(git log --merges -1 --format=%H)^1}"
bun install || exit 1
bun run check || exit 1
bunx turbo run test --continue --only --filter="[$base...HEAD]"; test_code=$?
if ! git diff --quiet "$base" HEAD -- scripts; then
  bun test ./scripts || test_code=1
else
  echo "merge-check: scripts unchanged, skipping scripts tests"
fi
echo "TEST $test_code"
bunx turbo run build --only --filter="[$base...HEAD]"; build_code=$?
echo "BUILD $build_code"
[ "$test_code" -eq 0 ] && [ "$build_code" -eq 0 ]
