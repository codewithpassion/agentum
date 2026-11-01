---
id: DI.1
title: "Daemon releases built at deploy and installed with one curl command from the site"
milestone: DI
size: M
status: in_progress
depends_on: []
branch: task/DI.1-daemon-install
lane: ops
executor: claude
---

Dom's request, 2 November 2026: the machine daemon must be built before a deploy and be installable from the site with one `curl` command, the way Bun is.

Today `apps/daemon` builds only by hand on the machine (`bun run build`, or `build:release` for Linux x64 and arm64, about 100 MB each), and nothing publishes it. The enrol dialog (`apps/web/src/components/machines/enroll-commands.ts`) tells a person to run `harbourmaster enroll ...` with no way to get `harbourmaster`. `apps/computer/scripts/build-all.sh` already names a server `/install.sh` and `<release_base>/latest/hm-computer_<os>_<arch>`, but neither exists. The repository is private, so GitHub releases aren't an option.

## Decisions
- Binaries live in the existing `FILES` R2 bucket of each environment under `releases/`, because Workers static assets stop at 25 MiB per file. No new binding. The Worker streams them. Confirm nothing else writes under `releases/`, and that no workspace route can read that prefix.
- Downloads and the install script are public with no sign-in, like Bun's. The binary contains no secrets; check this in the task.
- Linux x64 and arm64 for `harbourmaster`, because `install-service` needs systemd. Any other platform gets a clear message and exit 1. `hm-computer` keeps its four targets from `build-all.sh`.
- Updating means running the same command again. No automatic self-update in this task.

## Scope
- Version: each release is `<package version>+<short commit>`, embedded with `bun build --define`, so `harbourmaster --version` and the daemon's hello report the real build. Without a define it falls back to the package version. `hm-computer` gets the same through `HM_COMPUTER_VERSION`.
- `apps/web/scripts/publish-releases.ts --env staging|production`, with pure helpers tested separately: builds both products, computes SHA-256, uploads with `wrangler r2 object put --remote` to `releases/<product>/<version>/<file>`, and writes `releases/<product>/latest.json` (version, files, hashes) last, so a failed upload leaves `latest` on the old build. It skips a product whose `latest.json` already has this commit. It refuses to publish from a dirty tree unless given `--allow-dirty`.
- Build before deploy: `deploy` and `staging:deploy` in `apps/web/package.json` run the publish step before `wrangler deploy`, so the site never offers a build that isn't there. Previews use the staging bucket and don't publish.
- Routes in `apps/web/src/server/routes/releases.ts`, mounted before Clerk:
  - `GET /install.sh` and `GET /install-computer.sh`: the script with this deployment's origin filled in, `text/plain`, short cache.
  - `GET /releases/<product>/latest.json`, and `GET /releases/<product>/<version>/<file>` streaming from R2 with an immutable cache header, `Content-Length` and `ETag`. Only names from the manifest's pattern are served, so a path can't reach another key. An unknown one gets 404.
- The install scripts, POSIX `sh`, working under `curl -fsSL <origin>/install.sh | sh` and `| sh -s -- --code <code>`:
  - Detect the OS and architecture, read `latest.json`, download to a temp file with a progress bar, verify the SHA-256 (with `sha256sum` or `shasum`, refuse to install on a mismatch), then move it atomically to `~/.local/bin`.
  - Say what to add to `PATH` if that folder isn't on it. Warn if `claude` isn't found, because the daemon needs it.
  - For `harbourmaster`: run `install-service` before `enroll`, as `main.ts` requires, skipped with `--no-service`. Run `enroll <code> --server <origin>` when given `--code`. When re-run on an enrolled machine, replace the binary and restart the service. Handle `install-service`'s exit 2 for missing lingering by printing the fix. On a box without systemd, say so and how to run the daemon by hand.
  - Stop on the first error with a clear message. Everything sits inside a function called on the last line, so a cut-off download can't run half a script.
- Enrol dialog: `daemonCommand` becomes the one curl command with the code and this origin, and `binaryCommand` likewise. Machines page empty state and README show the command with no code.
- Machine version: store the `daemonVersion` from the hello on the machine row (one generated migration, including `migrations/meta/`). The machines page shows each machine's version and, when it differs from `latest.json`, a note with the same command to update. Gate review 2 of AA (`docs/reviews/AA-2.md`, N4) needs this: a daemon without `currentApprovals` freezes an agent once a peer's answer queues a follow-up run, so people must be able to see old daemons.
- A new page isn't involved, but `/install.sh` and `/releases` must not be caught by Clerk redirects.

## Check
- Tests: helpers for version, keys and manifest; each route including a path that tries to escape the prefix; a 404 before any release exists; `sh -n` and `shellcheck` if available on both scripts.
- A real run of each script in a temp `HOME` against a local server holding a small stub binary: a good install, a hash mismatch refused with nothing installed, an unsupported platform refused (by faking `uname`), a re-run replacing the binary, `--code` passing the code and origin through, and `--no-service` skipping the service.
- `bun run build` output of the daemon holds no secret values from `apps/web/.env.local`: grep the binary for them.
- `bun run check && bun run test && bun run build` pass. The workerd `guest execution` and `ArtifactRoom` tests and the Chrome print test are known load flakes; if one is the only failure, run it alone and record that.

The real deployed check is the controller's: after the merge it deploys staging and runs the curl command against it.

## Log
- 2026-11-02: created from Dom's request. Dispatched.
