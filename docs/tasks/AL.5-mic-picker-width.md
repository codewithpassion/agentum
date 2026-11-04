---
id: AL.5
title: Wider microphone picker
milestone: AL
size: XS
status: in_progress
depends_on: []
branch: AL.5-mic-picker-width
lane: web
executor: codex
---

Dom, 5 Nov 2026: the dictation mic picker is so narrow that device names wrap mid-word ("Microphon e (USB PnP Audio Device)"). It needs a much wider menu when open so the names fit.

Cause: `DropdownMenuContent` in `apps/web/src/components/dictation/dictation-button.tsx` takes the shadcn default `w-(--radix-dropdown-menu-trigger-width)`, the width of the small chevron button.

## Scope
- In `dictation-button.tsx` only (never edit `components/ui/`): give the content its own width through `className`, about 18rem minimum and up to 28rem, never wider than the viewport less 2rem, sized to its longest label (`w-auto` or `w-max` with min and max). Align it so it opens toward the free side of the screen (`align="start"`).
- Long labels wrap at word boundaries only, never mid-word.

## Check
- A test that the picker content carries the width classes.
- `bun run check && bun run test`.

## Log
