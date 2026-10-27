# L.4 implementation status

Incomplete. Branch `t3/implement-live-artifacts`; partial implementation commit `1b0ee949`.

Artifact session list, search, get, transcript and user run reads now filter through the artifact's workspace, deletion state, audience, owner, admin status and active same-workspace user membership. A service test exercises a private artifact and a malicious cross-workspace membership. The existing session test suite passes (45 tests). Root build passed.

The continuation and session creation paths still need artifact authorization; the live-artifacts service, router, room/content ports, persistence, ticket signing, comments, ask, checkpoints and restore have not been implemented. No L.7 or L.6 integration contract is available yet. Do not enable artifact sessions based on this partial change.
