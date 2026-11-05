---
id: RC.3
title: Service install, run-as modes, agent user
milestone: RC
size: M
status: done
depends_on: [RC.2]
branch: RC-rust-client
lane: rust-service
executor: codex
---

Spec: `docs/v3/machine-client.md` ("Instances, names and paths", "Who agents run as", "Permissions and help"); today's behaviour in `docs/v3/machine-client/inventory.md` 1.12, 1.13, 4.

## Check
- Tests render the user and system units for each run-as mode and compare to golden files; `RestartPreventExitStatus=3 4 5`; the unit name carries the instance.
- Tests for each permission failure path produce the spec's explanation (fake command runner, no real systemctl).
- A real `--user` install, `status`, `logs`, `restart` and `uninstall` on this host for a throwaway instance against a local fake server, then cleaned up. Do not install a system service on this host.
- `bun run check && bun run test` pass.

## Log
- 2026-11-06: Codex built it (f680e088). Opus security review: root symlink attack via chown/chmod, canonicalized claude path, non-idempotent uninstall, plus 10 more; fixed in 4f407630. Sudoers rule aligned with RC.4/RC.5 in fe64f41b; final CLI fixes 8bc41a7f. Merged. Real sudo and systemd behaviour waits for RC.7.
