---
id: DF.3
title: Shared app gateway package and Workers review
milestone: DF
size: M
status: done
depends_on: [DF.2]
branch: DF.3-gateway-package
lane: web
executor: claude-opus
---

Dom asked for a shared package for the code both Workers use, and a fresh review of everything built around the Workers.

## Log
- 2026-11-05: An Opus subagent moved the gateway into `@repo/app-gateway` (02fec6cc), so `apps/hooks` no longer imports from `apps/web`.
- Fixed, with failing tests first:
  - `HooksMain` now serves endpoint viewers only (c67bbfff).
  - `app.error` events no longer store visitor details (81f1d464).
- Dom's decisions:
  - Background cap is 25 s, so timeouts are recorded (8c980cab).
  - `HooksMain` trust stays the account boundary, and the docs say so.
  - The visitor salt is read after the app answers (58bb58a9).
- Docs: bf2485c5.
- Checks pass: check, test, build, the bundle grep, and 10 clean runs of the hooks tests.
- Left for later:
  - The host allowlist ignores the port, as the main Worker's does.
  - `harbourmaster.rockyshoreslabs.io/hooks/*` still reaches the main Worker's fallback route.
