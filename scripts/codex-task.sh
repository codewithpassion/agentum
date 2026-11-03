#!/usr/bin/env bash
# Runs one Codex job in a Agentum task worktree, with no sandbox and no
# approval prompts. Codex's bwrap sandbox fails on this host, so the guard is the
# worktree check below: Codex only ever runs inside a disposable checkout.
# Usage: scripts/codex-task.sh <worktree> <brief file> <log dir>
# CODEX_TASK_TIMEOUT overrides the 90 minute limit (a `timeout` duration, e.g. 1m).
set -uo pipefail

WORKTREE_ROOT="/home/roboto/devel/harbourmaster-wt"

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <worktree> <brief file> <log dir>" >&2
  exit 2
fi

worktree="$(realpath -e -- "$1" 2>/dev/null)" || { echo "refusing: $1 does not exist" >&2; exit 2; }
brief="$(realpath -e -- "$2" 2>/dev/null)" || { echo "refusing: brief $2 does not exist" >&2; exit 2; }
mkdir -p -- "$3"
log_dir="$(realpath -e -- "$3")"

case "$worktree" in
  "$WORKTREE_ROOT"/*) ;;
  *) echo "refusing: $worktree is not under $WORKTREE_ROOT/" >&2; exit 2 ;;
esac

# A linked worktree has a .git file; the main checkout has a .git directory.
if [ ! -f "$worktree/.git" ] || ! git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "refusing: $worktree is not a git worktree" >&2
  exit 2
fi

last_message="$log_dir/last-message.md"
events="$log_dir/codex.jsonl"
rm -f -- "$last_message"

timeout -k 30 "${CODEX_TASK_TIMEOUT:-90m}" codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  -C "$worktree" \
  -m gpt-6.1-sol \
  -c 'model_reasoning_effort="medium"' \
  --json \
  --output-last-message "$last_message" \
  - <"$brief" >"$events" 2>"$log_dir/codex.stderr.log"
code=$?

if grep -qi "usage limit" "$events" "$log_dir/codex.stderr.log" 2>/dev/null; then
  limit="yes"
else
  limit="no"
fi

echo "codex exit=$code usage_limit=$limit last_message=$last_message"
exit "$code"
