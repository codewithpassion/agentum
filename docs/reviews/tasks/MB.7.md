# MB.7 Mobile computer takeover

## Verdict per round

Round 1: must-fix. Touch gestures also took over touch laptops and tablets at md and up; the Keyboard button's focus could scroll a zoomed view to the corner; touch state was not reset when control was lost. All fixed in f75abf4.

Round 2 (fixes only): clean.

## What changed (F-14)

- `desktop-touch.ts`: pure gesture state machine. One finger tap is a left click, a 500ms hold is a right click, a one-finger drag moves the pointer with the left button down, two fingers scroll (content follows the fingers). Unit tests in `desktop-touch.test.ts`.
- `use-desktop-input.ts`: routes touch pointers through it, mouse pointers behave as before. Backspace from `beforeinput` (`deleteContentBackward`) is sent, since phone keyboards skip `keydown`.
- `desktop-screen.tsx`: a phone-only bar (`md:hidden`) with a Keyboard button, Enter/Backspace/Esc/Tab/arrow buttons (`PHONE_KEYS`, tested), 1x/2x/3x zoom and a Pan toggle. The typing input is 16px so iOS does not zoom. Zoomed view scrolls inside its own box. Desktop layout is unchanged.

## Checks

Screenshots: `MB.7/m390.png` (390x844 harness, phone bar visible) and `MB.7/d1280.png` (1280x800, phone bar hidden).

The audit's problem stands: the only computer is offline, so a live screen was not tested. The browser check used a throwaway route (deleted) that mounted `useDesktopInput` and the phone bar against a plain div, with synthetic touch pointer events. Tap, long press, one-finger drag and two-finger scroll produced the expected `mouse_*` and `scroll` actions. Not verified on a real phone: the on-screen keyboard opening, iOS behaviour, and a real image from `apps/computer`.

## Nits and ideas

- Scroll speed uses the same 100px per click as the wheel; may want tuning on a real phone.
- Gesture mode is read on every pointer event, not latched at pointerdown, so a rotation across 768px mid-gesture could leave a stray mouse_up.
- `take()` focuses the keyboard without `preventScroll`.
- The phone-width gate and the reset on control loss have no unit tests.
- No pinch-to-zoom, only the zoom buttons.
