---
id: U.3
title: Clerk sign-in UI readable in dark mode
milestone: U
size: S
status: done
depends_on: [U.1]
branch: task/U.3-clerk-dark-mode
---

Reported by Dom on 17 Oct 2026 with a screenshot of `/login` in dark mode. Clerk's card is light (`#faf9f5`), but its heading, subtitle, "or" divider, labels, Google button text and footer text render in light colours, so they are unreadable. The email input is dark.

## Scope

`apps/web/src/integrations/clerk/provider.tsx` passes fixed light colours under older variable names (`colorText`, `colorInputBackground`, `colorInputText`, `colorTextSecondary`). The installed Clerk version probably uses newer names (`colorForeground`, `colorInput`, `colorInputForeground`, `colorMutedForeground`), so some parts fall back to defaults that follow the browser's dark colour scheme. Check this against the installed `@clerk/tanstack-react-start` / `@clerk/clerk-js` types.

Make every Clerk component (sign-in, sign-up, org creation, user button menu) follow the app's theme: the light brand tokens in light mode and matching dark tokens from `styles.css` `.dark` in dark mode, using the variable names the installed Clerk version supports. Use however the app decides dark mode (the `.dark` class or `prefers-color-scheme`, see styles.css and the root route). Keep the comment explaining why the tokens are restated.

## Check

Browser, dev login on a local dev server, plus a signed-out `/login`: screenshot the sign-in card in light and in dark mode, and the user button menu in dark mode. All text is readable, and contrast is at least AA on body text. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from Dom's dark-mode screenshot; dispatched on task/U.3-clerk-dark-mode.
- 2026-10-17: review clean after 1 fix round at f6a187d (docs/reviews/tasks/U.3.md). Merged.
