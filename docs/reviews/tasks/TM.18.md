# TM.18 review: a lead listens switch on the team page

## Verdict

Round 1 (d233b7f0): clean, 0 must-fix. No fix rounds.

Browser proof: `docs/reviews/tasks/TM.18/browser.md`. Pass at 1280x800 and 390x844. With the switch off, a message that names nobody left the lead asleep. With it on, the lead woke. A member without edit rights sees no switch. One unexplained `400` console line appeared once in the first verifier run; a second fresh verifier could not reproduce it in six sessions and traced the same message format to Clerk's dev instance, so it is recorded as third-party noise.

## Nits left

- `lead-listens-switch.test.tsx` renders static markup only. It does not exercise a toggle, the saving state or a rejected save.
- No test covers hiding the switch when `canEdit` is false (the browser check does).
- The label and description sit in a plain `div`; `FieldContent` from `field.tsx` is the shadcn fit.
- The comment above `setLead` in `team-page.tsx` still names only the lead picker and rules editor, not `setLeadListens`.
- The switch shows when the team has no lead, where it has no effect yet. The value persists for a later lead.
- Readers who cannot edit the team see neither the state nor the sentence.

## Ideas beyond the scope

- Show the lead-listens state read-only to people who cannot edit the team.

## Steps for Dom

None.
