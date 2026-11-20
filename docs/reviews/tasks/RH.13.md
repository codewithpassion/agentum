# RH.13 review

Round 1 at fe0b0212: not clean, one must-fix. `useSwitchWorkspace` in `components/rail/` still defaulted to `/desk`, so the landing page's no-access list and the top-bar workspace menu ended on the desk. The task's grep scope (`routes/` and `integrations/`) did not cover it.

Fix round 1 at 94658fdb: the hook's default and its doc comment are `/home`, and CLAUDE.md's two matching sentences say `/home`. The re-review on that commit is clean, no must-fix.

Check, test and build pass at both commits. Browser proof is in `docs/reviews/tasks/RH.13/browser.md`: pass at 1280x800 and 390x844, no console errors and no failed requests, with the two caveats below.

## Choices

The pure invitation step kind `"desk"` is now `"home"`, with its test, so the name matches what it opens. The reviewer agreed this is in scope.

## Nits left

- Nothing tests the `/home` default of `useSwitchWorkspace`. The hook has no test file, and the browser run covers it.
- The workspace menu in the top bar now switches to `/home` as well. That follows RH.3 (home replaces the desk as the landing) but is a product call.

## Browser caveats

- The real-invitation `Join` path was not run, because a real Clerk invitation changes Clerk data. The no-org and member paths of `/accept-invitation` both end on `/home`.
- Flow C (the landing no-access list) could not be reached through Clerk state: with the dev user, `setActive({ organization: null })` and a fresh dev sign-in both leave the organisation active. The verifier answered only the `/api/trpc/me` call with a 401 from the page and drove the real list and the real hook from there. The only console error is the browser's line for that injected 401.
- The top-bar menu was not driven: the dev user has one workspace, and choosing the current one is a deliberate no-op. It calls the same hook as flow C.

## Beyond scope

- `docs/ux-review/rail/spec.md` and the research notes may still describe the desk as the landing. Not checked.

## For Dom

Nothing needs your accounts. To try the real invitation path, invite a second address from `Invite people` on a staging workspace, open the email link and confirm `Join` ends on `/home`.
