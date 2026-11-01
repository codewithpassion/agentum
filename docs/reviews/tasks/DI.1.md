# DI.1 review: daemon releases and the curl install

## Verdicts

- Round 1 (61cb521): not clean, 3 must-fix. A re-run only restarted the service, whose unit still named the old binary. A re-run with no unit exited 1 after replacing the binary. Re-running the `--code` command failed on the used code.
- Round 2 (ed0fe2d, fixes only): not clean, 2 must-fix. The fix re-ran `install-service` on an update, which re-provisions the agent user and overwrites the sudoers rule from `which claude`.
- Round 3 (b026fc3, fixes only): clean. `install-service --refresh` rewrites the unit for the running binary and restarts it, and skips the agent user and sudoers. One later wording fix (the no-unit hint suggests `--refresh`) came after the clean verdict.

## What was checked

- `bun run check`, `bun run test` and `bun run build` pass. The client bundle has no `drizzle`.
- A real run of `install.sh` piped from `vite dev` into a temp `HOME`, with the stub binary in the local R2 emulation: it installed, ran `enroll <code> --server <origin>` and printed the version. `/install.sh` and `/releases/...` answer without a Clerk redirect.
- The daemon built with `--define process.env.HM_DAEMON_VERSION=...` reports that version, and without it reports the package version. 15 values of `apps/web/.env.local` (8 characters or longer) do not appear in the daemon binary.
- Nothing else writes under `releases/`. Every other R2 key starts with a workspace ULID, `payloads/`, `skill-blobs/` or `vm-snapshots/`.
- `shellcheck` is not installed on this machine. Both scripts pass `sh -n` and `dash -n` and were read by eye.

## Behaviour to know

- An update is the same command run again. On an enrolled machine the script ignores `--code`, replaces the binary and, when the `harbourmaster` unit exists, runs `install-service --refresh`. With no unit it says so and restarts nothing.
- The new `--refresh` flag on `install-service` is how an update avoids touching the sudoers rule.
- `daemonVersion` is stored in the new `machines.daemon_version` column (migration 0040) and still sits in `capabilities` too. The machines page shows it, and a note with the install command when it differs from `latest.json`. Any difference counts, because builds are ordered by publish time.
- `hm-computer` takes the daemon's release version string.

## Nits left

- `install.sh` says "now runs $BIN" after a fresh install, where the service is enabled but not started yet.
- Under `su -` with no user bus, an update exits 1 after the binary and unit are replaced. The closing message does not say what to do next.
- A preview's script can meet an older staging binary that has no `--refresh`, until staging publishes this build.
- `--refresh --claude <path>` ignores `--claude` silently. A new entry in `AGENT_COMMANDS` needs a manual `install-service`, which updates no longer do.
- No test for `main.ts` passing `--refresh`, for `--refresh` with no config, or for the unit file existing while `systemctl cat` fails.
- Alpine (musl) passes the platform check and then fails on the glibc binary.
- `--allow-dirty` cannot be passed through `bun run deploy --`. Run `bun scripts/publish-releases.ts --env <env> --allow-dirty` first.
- `install-harness.ts` sits in `src/server/releases/` and imports `bun`. It is a test helper outside the Worker bundle.
- `apps/computer/internal/desktop/desktop.go:133` points at `install.sh --desktop`, which does not exist. It predates this task.

## Beyond scope

- Automatic self-update, and a `harbourmaster update` command.
- macOS support for the daemon (needs launchd).
- A signed manifest, so the hash does not rest only on the server that serves the binary.

## Steps for Dom

- Apply migration 0040 to each remote D1 before its deploy (`wrangler d1 migrations apply DB --remote`, with `--env staging` for staging). `bun run deploy` does not run migrations.
- Deploy from a clean tree. `publish-releases` refuses a dirty one, and the main checkout holds three untracked PNGs in `apps/web` (`s1.png`, `vm1-return.png`, `x.png`).
- The machine that deploys needs Go or Docker for the `hm-computer` build. Without either, `go.sh` skips the build and the publish stops at the missing files.
- Wrangler sends the object key with its `+` unencoded. After the first staging deploy, download a real binary (`curl -fsSL <staging>/releases/harbourmaster/<version>/harbourmaster-linux-x64 -o /dev/null`), not just `latest.json`. If R2 stores the key differently, change the version separator in `manifest.ts`.
- The deploy uploads to the real `FILES` bucket, so the first publish needs the wrangler login for that account.
