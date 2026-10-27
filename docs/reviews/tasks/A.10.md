# A.10 review: share dialog, access log and links switch

## Verdicts

- Round 1 (0d1cdcb): not clean, 3 must-fix. The access log filter select was 32px on phones, Revoke and Copy showed to members who cannot manage links, and no test showed Revoke is a confirm trigger.
- Round 2 (7e9dd20, fixes only): clean.

## Browser check

Not run here. The services and wiring (A.2, A.3, A.6) were not in `v3/artifacts` when the units landed, and the share and views procedures still answer NOT_IMPLEMENTED. The browser check (R1.27, R1.29, R1.31 display, a fresh profile opening a created link) moves to A.14. Component tests cover the expiry choices, pin semantics, revoke confirm, the admin-only switch and the log rows. The share page `/s/$token` belongs to A.8.

## Gaps in the A.1 contract (worked around, nothing changed)

- No procedure lists a version's files. `ShareDialog` takes an optional `dataFiles` prop; without it the dialog shows "N files, X KB in this version" from `currentVersion`. The viewer page (A.8) can pass the manifest's non-entry files.
- No workspace-level read of the link switch. `settings.artifacts.tsx` reads `linksEnabled` from the first artifact's `get`, and falls back to on. A silent fallback means an admin may see "on" while it is off when no artifact exists.
- Shares and views carry user ids only, so "Created by" shows the raw user id and member opens show "Member, in viewer".

## Nits left

- `share-dialog.tsx`: `load()` has no stale-response guard; the audience buttons have no pending state; the form does not reset after create; a 0-byte file shows "1 KB"; the 672px desktop dialog may scroll sideways with the 8-column link table.
- `access-log.tsx`: the shares fetch and filter changes keep old rows on screen until the new page arrives.
- `create-link-form.tsx`: the date input has no `min`.
- Mixed import style (`./x.ts` vs `./x`) across the new files.
- No test for the access log stale-response guard, the pin radio inside the component, or the sheet on mobile.
- "Artifacts" sits under "Agents can use" in the settings nav; "Access to Harbourmaster" may fit better.

## Beyond scope

- A workspace-level `artifacts.settings` read (links switch, quota) and user display names on shares and views.
- A DOM test library (happy-dom or testing-library) so dialogs and the sheet can be tested by interaction.

## Steps for Dom

None. For A.14: open a created link in a fresh profile, revoke and reopen, read the log rows at 1280x800 and 390x844, and flip the switch in Settings > Artifacts as an admin.
