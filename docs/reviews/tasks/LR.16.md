# LR.16 review

Branch `task/LR.16-deck-controls-grant-page`.

## Verdict

Round 1 at fd56666: clean, no must-fix.

## What changed

- `deck-editor.css`: the 450px rule that gave `.ld-toolbar` controls a 40px minimum now covers every button, select, input and textarea in `.ld-editor`. Desktop rules are untouched. Browser measurement at 390x844 with three slides and the inspector open: 52 controls, 0 under 40px, no horizontal overflow. Desktop buttons stay 33px.
- `artifacts/user-grant.ts` and `service.ts`: `artifacts.get` and `artifacts.versions` also admit a user with a live (not revoked, not expired) member grant on a document or deck. Every other action keeps owner and admin rules.
- Tests in `service-access.test.ts`: granted user opens, ungranted member does not, the grant opens nothing else (`readFile`, `list`), revoked and expired grants fail, a grant on a static kind opens nothing. Signed-out users are redirected to login by the route loader on UNAUTHORIZED, so no service test.

## Nits left

- `user-grant.ts` repeats the grant query and expiry test from `userRole` in `live-artifacts/access.ts`.
- No test for kind `deck`, nor for owner-only actions staying closed under a grant.
- Resize and rotate handles in `scene.tsx` get 40px height but stay about 20px wide.
- `summary` elements ("Elements and layers", "Agent changes") are not covered by the 40px rule.
- The grant also opens `artifacts.get` and `artifacts.versions` for API key and OAuth user principals over MCP and REST.

## Steps for Dom

None.
