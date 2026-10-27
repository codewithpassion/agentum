# MB.5 review: mobile map editor and inspector

## Verdicts

Round 1 (d55bbb7): not clean. Two must-fix items: no browser evidence of tap-to-plug, and the new Wire and Unplug inspector sections also showed on desktop.
Round 2 (ca396a7): clean. Touch controls now reach the inspector only below 768px, pick scrolls only on phones, and the screenshots show the pick and the plug.

## What changed

F-19: tapping a palette tool picks it (banner "Tap an agent to plug in X", Cancel button), and the next tap on an agent plugs it in. Drag and drop is unchanged. Code: `use-tap-to-plug.ts`, `tool-palette.tsx`, `map-touch-panels.tsx` (PickBanner).
F-20: below 768px the inspector opens as a bottom sheet (`InspectorSheet`). Trigger nodes get a "Connect to" select with a Connect button and "Delete wire to X" buttons. Agent nodes get an "Unplug" list with Remove buttons. All are 40px high. The tiny wire x and chip x are hidden on coarse pointers. Code: `map-inspector-touch.tsx`, `map-inspector.tsx`, `editor-logic.ts` (`connectChoices`, `deletableWiresFrom`, with tests).
F-18: on phones the fit-to-view stops at zoom 0.7, so nodes stay readable and the person pans. "Fit view" uses the same rule. Chosen over a list view because it needs no second renderer.

## Screenshots

In `docs/reviews/tasks/MB.5/`: `editor-390.png` (map readable), `picked-390.png` (banner), `plugged-390.png` (after the tap), `sheet-390.png` (inspector sheet), `wire-390.png` and `confirm-390.png` (Connect to, then the confirm), `unplug-390.png`, `desktop-1280.png` (desktop unchanged).

## Nits left

- `unplug-390.png` has the dev-only TanStack devtools button over the last Remove button.
- The edge id `${kind}:${from}:${to}` is built in three places. One helper would do.
- The 767px query is a literal in `map-canvas.tsx` and `use-tap-to-plug.ts`, next to `use-mobile.ts`.
- `pointer-coarse:hidden` was not seen in a screenshot, because agent-browser reports a fine pointer.
- The inspector's Tools row already has per-tool toggles, so the Unplug list partly repeats it.
- `selectNode` in `use-tap-to-plug.ts` has no unit test.
- Tablets 768px and wider with a touch screen get tap-to-plug but not the inspector wire and unplug controls.

## Ideas beyond scope

A list view of the map for very large graphs. A shared breakpoint constant.

## Steps for Dom

None.
