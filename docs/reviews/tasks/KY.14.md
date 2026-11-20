# KY.14 review: only admins change or delete a workspace secret

## Verdicts

- Round 1 (9906fbca): clean, no must-fix, seven nits.

## Browser check

Verified in a real browser at 1280x800 and 390x844, report and screenshots in `docs/reviews/tasks/KY.14/browser.md`. As the admin dev user, create, Replace value, Edit hosts, Edit rules, Change mode and Delete all work. As `dev+member@harbouredgeintelligence.ai` (org:member, same workspace), the note is shown, the list is readable, and New secret and every row button are disabled and do nothing when clicked.

Caveats from the verifier, not traced to this change: one console 400 on the member's first `/home` load after sign-in, and one 400 on the phone admin run that matched an invalid-host save the verifier made while testing (valid input never gave a 400). The Keys tab loads, but this build shows no secret grant list there, so grants were not exercised in the browser; the service tests cover them.

## Decision taken

The task's default: `secrets.create`, `update` and `remove` accept an org admin on a session or an admin key only. A write key, a connected app, Slack and plain members are refused, owners of an agent included. `grant`, `revoke` and `setGrants` keep the owner-or-admin rule. The narrower alternative in the task (owners of granted agents) was not built. The old "only an admin changes the mode" check went, since update is admin-only as a whole.

## Nits left

- `secrets.test.ts`: the refused list has no OAuth or Slack principal with `isAdmin: true`, so a guard that dropped the `via` check would still pass. The "owner-not-admin" case holds no secret granted to an agent that user owns.
- `secrets-table.tsx`: the "Only an admin can change secrets" title never shows on a disabled button (`pointer-events-none`). The page note carries the reason. The New secret button has no title either.
- `agent/profile/sheets/secrets.tsx:115`: with no secrets, the Keys tab still tells a member to add one under Settings, Passwords and keys. A member cannot now.
- `requireSecretAdmin` in `secrets.ts` repeats `secretManager` in `admin.ts` and differs from the one in `connectors.ts` (session admin only). A shared guard in `guards.ts` would keep them in line.

## Beyond scope

- Hide or reword the Keys tab's "add a secret" hint for members.
- One shared "org admin or admin key" guard for secrets, connectors and admin.

## Steps for Dom

None.
