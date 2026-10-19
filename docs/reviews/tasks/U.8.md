# U.8 review

Ctrl+Enter (Cmd+Enter on macOS) sends a chat message, Enter and Shift+Enter add a new line.

## Verdicts

Round 1, commit c2cab89: clean. No must-fix findings. `bun run check`, `bun run test` and `bun run build` passed, and the client bundle has no `drizzle`.

## What changed

A shared module in `apps/web/src/components/composer/` (`send-shortcut.ts`, `send-hint.tsx`) is used by the two message composers, the agent chat tab and the inbox post composer. The other Textareas (routine prompt, agent instructions) are configuration, not messages, and are unchanged. The agent chat submit now returns early when sending is disabled, because `requestSubmit()` ignores a disabled Send button.

## Browser check (dev server, dev login)

In both composers, Enter and Shift+Enter add a line, Ctrl+Enter sends, and the hint shows. With a macOS user agent the hint reads "⌘+Enter to send" and Meta+Enter sends. Ctrl+Enter in an empty agent chat sends nothing.

## Nits left

- Round 1 asked whether unit tests cover the check. The browser check above covers the rendered hint and Cmd+Enter.
- The "Shift+Enter does not send" test repeats the plain Enter case (`send-shortcut.test.ts:31`).
- `isSendShortcut` also sends on Ctrl+Shift+Enter and Ctrl+Alt+Enter.
- The IME guard reads only `isComposing`. Safari can end a composition with `keyCode` 229 and `isComposing` false, but Ctrl or Cmd has to be held.
- The iPhone and iPod user agents show the Cmd hint on phones without a hardware keyboard.
- The hint shows "Ctrl+Enter" until mount on macOS, to keep server and client markup equal.
- The post composer hint has no id and is not in `aria-describedby`, unlike the chat.

## Ideas beyond scope

- Apply the same shortcut to the new-thread title if it ever becomes multi-line.
- A component test setup (DOM environment) for rendering `SendHint`.

## Steps for Dom

None.
