# AA.9 review record

Pairing code for outside A2A clients. Spec: `docs/v3/agent-connections.md`, "Pairing code, for an outside client we haven't given a key".

## Rounds

- Round 1, at c70a87ce: must-fix. The limit of 3 pending requests was a count followed by an insert, so parallel unauthenticated requests passed it (10 of 10 got a code). The switch state in `PairingSection` carried over between agents.
- Round 2, at ac134e77: must-fix. A paired connection showed "Key starts with" followed by characters of the token's hash, because the request's hash tag was copied to the connection.
- Round 3, at 538685fb: clean.

Fixes: the limit is one conditional `insert ... select ... where count < 3` statement (checked on bun:sqlite and local D1), `key={agentId}` on the section, an event for each wrong code (the fifth also writes the lock event), the request keeps four characters of the token's hash and never of the token, an approval whose token already belongs to a connection is refused plainly, a paired connection gets a null token prefix, `pairableAgent` answers null without `SECRETS_KEY`.

## Decisions

- During a lockout new requests are refused too (a plain 401), as Hermes's `generate_code` does.
- Turning the switch off deletes the requests still waiting, so an earlier code stops working.
- The code is an HMAC of the request id and the token under `SECRETS_KEY`, as the task log says. Only its SHA-256 hash is stored.
- `requestPairing(agentId, token)` takes the agent id as the task says. The route finds it with `pairableAgent(publicId)`, which also answers null for pairing off, unpublished, locked or no secrets key, before any body is read.
- The route answers only `SendMessage`, on JSON-RPC and on REST `message:send`. JSON-RPC reads the envelope for the method and id, REST reads no body, and `params` is never looked at.

## Nits left

- `approvePairingCode` does not check `pairing_open`. A request that races the switch-off can leave a row that still works until it expires.
- Two approvals racing past the token-collision check end in a unique-index error rather than the plain conflict message.
- Two wrong codes that reach the lock in the same millisecond both write a lock event.
- With `SECRETS_KEY` unset the switch still turns on and every client gets a 401, with nothing shown to the owner.
- The 8-character code is 40 bits, so its stored hash can be enumerated by someone who can read the table.
- Rotating `SECRETS_KEY` makes a same-token retry return a code that no longer matches the stored hash, until the request expires.
- REST answers with a code for any body, while JSON-RPC answers 401 for a malformed one.
- The reply text says "up to 1 hour"; the rest of the wording is fixed.
- No test asserts that a paired connection has a null token prefix or that no event payload holds the hash tag.
- The agent card text on the profile still reads "A peer with an invite or a key can reach this agent." with pairing on.
- `PairingHelp` sits under the Create key button of the key dialog.
- `PairingSection` has no component test for the reset between agents.

## Ideas beyond the scope

- A throttle on the unauthenticated path. A stranger can hold all 3 pending slots for an hour, which the spec accepts.
- A Needs you card is out on purpose. A pending-count badge on the card would be a small alternative that still has no approve button.

## Steps for Dom

None. No new binding, secret or migration. Pairing is off for every agent until an admin or owner turns on "Accept pairing requests" on the agent's page.
