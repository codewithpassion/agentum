# CL.1: retire the TypeScript daemon and the Go computer client

## Verdict

Clean after 0 fix rounds.

- Round 1 (91f4728b): clean, four nits. Three were fixed in the next commit (the stale `token-prefixes.ts` comment, two stale lines in `docs/HANDOVER.md`) and one got a test (a retired product whose files are still in R2 answers 404 and never reaches the bucket).

## What changed

Moved into `apps/agentum` with `git mv`: the desktop packaging (`packaging/desktop`, minus the Go copy of `seccomp.json`, which was byte-identical to the Rust one), the wire fixtures (`testdata/protocol`, `testdata/enroll`) and the tool-run fixtures from the daemon (`testdata/tool-run`). The Rust tests, `packages/protocol/src/computer.test.ts`, both Agentum Dockerfiles and their `.dockerignore` files read from the new paths. The one Rust test that compared `private_claude` text against `apps/daemon/src/install-service.ts` now holds the expected sentence itself.

Removed: `apps/daemon`, `apps/computer`, `install.sh`, `install-computer.sh` and their tests, the `agentum` and `hm-computer` products in `PRODUCTS` and `PRODUCT_FILES`, their builders in `publish-releases.ts`, the older-client commands and the "Older clients" block on the enrol dialog, and `stubDaemon` in the install harness.

Old install URLs: `/install.sh` and `/install-computer.sh` answer 200 with a short `sh` script that prints the `install-agentum.sh` command (and the `AGENTUM_ENROLL_CODE` form) and exits 1. A 4xx would hide the text, because `curl -fsSL` drops the body of a failed request. Retired products under `/releases/` answer 404.

Not changed: the wire protocol, `/releases/agentum-rs/*`, `install-agentum.sh`, the enrol schemas that still accept the legacy request bodies. The release version still comes from a package version of `0.1.0` plus the commit, now read from `apps/agentum/package.json`.

Machines page: "Add computer role" shows only for Rust machines, because the old flow attached the Go client to a TypeScript daemon machine. The update hint compares only against the `agentum-rs` version, so a row last seen on a retired client gets no hint. The `machines.newestDaemonVersion` default product is now `agentum-rs`.

## Decisions to check

`.github/workflows/computer.yml` also published the Rust images (`agentum:latest`, `agentum:desktop`). The task says to remove it, but deleting it would drop the only publisher of those images, so it is now `agentum-images.yml` with the two Go image jobs removed. It is still `workflow_dispatch` only. The Docker commands on the enrol dialog name `ghcr.io/codewithpassion/agentum`, which this workflow still builds.

## Checks run

`bun run check` (ultracite, typecheck for every workspace, boundary lint, `cargo fmt --check`), `bun run test` (every workspace, plus `bun test scripts`), `bun run build`, and a grep of `apps/web/dist/client` for `drizzle` (nothing). In `apps/agentum`: `cargo test` (all suites pass) and `cargo clippy -- -D warnings`. The disk was full, so the Rust target went to `/dev/shm` and was not kept. Several Rust lib tests that spawn fake binaries (`abort_escalates_to_kill_and_reaps_whole_group`, `version_probe_times_out_without_stalling_runtime`, `prerequisites_probe_only_fake_binary_and_check_only_version`, a doctor claude test) fail now and then under load, a different one each run. The same flake showed on an unmodified `main` checkout (1 of 4 runs), and a full `cargo test` run passed on this change, so it is not from CL.1. Worth its own task.

## Not verified

- The task's check "no machine on an old client in the last 14 days" is Dom's go, per the 11 Nov log line. Nobody queried production.
- The staging daemon on Morosini has to move to the Rust client before this merges (task log). Not checked here.
- Docker image builds (`Dockerfile.desktop` with the moved packaging paths) were not run, only the file paths were checked.
- The staging checks in the task file are the controller's.

## Nits left

None open.

## Ideas beyond the scope

- `apps/web/src/server/releases/install-agentum.sh` is still named for the one product it installs. The old `install.sh` name could be dropped from docs and the legacy-host comment once the URL message has been live a while.
- Machine rows from the retired clients stay in the database. Revoking them (starting with `morosini-prod`, the rollback path) is for Dom after CL.1 is on production.
- The older `docs/` task and analysis files still describe `apps/daemon` and `apps/computer`. They are history, so they were left alone.

## Steps for Dom

- After CL.1 is on production, revoke the `morosini-prod` machine row, as the 11 Nov log line says.
- The old `releases/agentum/` and `releases/hm-computer/` objects can be deleted from the `FILES` bucket whenever you like. They are no longer served, and the next publish writes only `agentum-rs`.
