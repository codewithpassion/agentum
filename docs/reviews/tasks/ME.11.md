# ME.11 review

## Cause

Pi appends a system message after the user's message when a prompt section changes. A cloud run's task folder differs per run, so the `library-files` section changes on every run after the first, and the second message of a conversation ends with that system message. The scripted model (`pi-run-faux.ts`) read `context.messages.at(-1)`, found the system message, and echoed an empty prompt. The run input the second run carries into `pi.submit` was correct. A real model sends the later system message as a native system block, so it still sees the user's message.

The bug was on `main`. It showed up only when `cloud.ts` ran past its second step, and step 8 then failed for a second, unrelated reason: runs write only to their agent's home and to folders with a write grant, and the script's agent had none for `/library/e2e-env`.

## Fix

- `fauxScript` reads the last message that is not a system message. Tests cover a trailing system update after a user message and after a tool result.
- `scripts/e2e/cloud.ts` sets a write grant on `e2e-env` for its agent.

## Rounds

Round 1 (21586f68): clean. No must-fix.

## Nits left

- The comment in `pi-run-faux.ts` names the task folder as the cause. A tool-set change (`toolsAdded`, `toolsRemoved`) also adds a trailing system message, and the fix covers it.

## Beyond the scope

- Because the task folder changes per run, every follow-up in a cloud session adds a `library-files` system message on real models (`library-env/library-tools.ts:69`). It works. Look at it only if prompt size or caching becomes a concern.

## Steps for Dom

None.
