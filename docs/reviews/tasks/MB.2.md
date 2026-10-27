# MB.2 review: tables as cards on phones, confirm before remove and revoke

## Verdicts

Round 1 at f7d1c3f: must-fix. The agent Connectors sheet lost `text-right` on its Remove cell, which moved the button on desktop. Nits: machine-row `flex-wrap` leaked to desktop, two-line Name cells sat side by side on phones, the actions cell had no vertical centring, cancel-run in the Log had no confirm.

Round 2 at 48721c0: clean. All of the above fixed.

## Findings from the audit

- F-16, F-26 and the table parts of F-09 and F-11: fixed. One helper, `apps/web/src/components/responsive-table/responsive-table.tsx` (`ResponsiveTable`, `ResponsiveCell`, `ResponsiveActions`), turns each row into a card below `md` with every column labelled and the actions last, 40px tall and wrapping. At `md` and up the markup renders the plain table. Used in the log, routine, trigger, secrets (page and agent sheet), API keys, machines, connectors (page and agent sheet) and library tables. The agent sheets reuse the same components, so Starts on, Tools and Secrets show cards inside the narrow sheet.
- F-24: fixed. `apps/web/src/components/confirm-action/confirm-button.tsx` (`ConfirmButton`, an AlertDialog naming the item) now guards Remove on routines, Revoke on triggers, Revoke on API keys, Delete on secrets, Remove connector from an agent, and Cancel run in the Log. Machine Revoke and library Delete already had dialogs, connector Delete opens one.

## Not changed, on purpose

- Approve and Reject on a pending proposal stay one tap. Rejecting declines an agent's request and removes nothing.
- `connected-apps/connected-apps-table.tsx` was not in scope and still scrolls sideways. It was empty in the audit.
- The page heading wrap on Machines and the settings nav height are F-25, not part of this task.

## Nits left

- Log cancel dialog shows "Cancel" next to "Cancel run". Clearer labels would help.
- Extra `{" "}` between Pause and Revoke in `trigger-table.tsx` is an extra flex item in the phone card (harmless).
- The two helper modules have no `index.ts` because biome's `noBarrelFile` forbids it, so callers import the file path.

## Ideas beyond scope

- Apply the same card layout to `connected-apps-table.tsx`.
- Move the settings tables' action buttons to a sticky bottom bar if cards get long.

## Browser check

Dev server on the worktree, dev login, local D1 with a routine, trigger, API key, machine, connector, secret, library file and agent. Screenshots (390x844 phone, 1280x800 desktop) are in `docs/reviews/tasks/MB.2-screens/`:

- Phone: `routines-390`, `triggers-390`, `log-390`, `library-390`, `api-keys-390`, `machines-390`, `connectors-390`, `secrets-390`, `agent-sheet-tools-390`, `agent-sheet-startsOn-390`, and the confirm dialogs `routines-remove-confirm-390`, `api-keys-revoke-confirm-390`.
- Desktop: the same pages as `*-1280.png`, plus `agent-sheet-tools-1280`. The tables look as before.
- Not run at 360x740. Cards are fluid, so width changes only wrap text.
- Screenshots taken before the round-1 fixes: `routines-390` and `machines-390` predate the stacked Name cell fix.

## Steps for Dom

None.
