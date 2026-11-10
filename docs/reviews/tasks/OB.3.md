# OB.3: The install script checks the machine and can make a desktop

## What changed

- `install-agentum.sh` runs `agentum doctor --instance <name>` after the service step (and after each restart on update) and prints only the `Problem:` blocks with their fix. A failed check never fails the install.
- The client sends the failed checks as `doctor: [{name, message}]` in both hellos (agent_host and computer), computed by `doctor::problems` (the doctor minus the server check). `machines.doctor_problems` (migration 0052) stores them, `MachineRecord.doctorProblems` returns them, and the Machines row shows "This machine needs attention" with each message. An empty list clears the row, an old client's hello leaves it alone.
- `AGENTUM_DESKTOP=1` installs xvfb, openbox, xdotool, xclip, chromium and fonts through apt (plus `chromium-sandbox` when apt has it) or dnf, as root or through `sudo -n`, before enrolling. It passes `--desktop` to `service install`. On re-enrolment with `--instance` it reinstalls the saved service with `--desktop`. On a plain update it installs the packages and prints the command that turns the desktop on.

## Verification on a clean Linux machine

A fresh Docker container (debian:trixie with systemd as PID 1, privileged, host network) for each path, never this host. The release came from a plain `cargo build --release` uploaded to the local R2 of a `vite dev` server (no Zig). Codes came from the Machines page after dev login.

- Without the flag: install, enrol, system service, doctor printed `claude login` as the failed check. `machines.doctor_problems` held it and the Machines row showed it. The installer made no package calls.
- With `AGENTUM_DESKTOP=1`: apt installed the packages, the config saved `desktop: true`, `agentum doctor` reported `desktop packages` ok, the computer role connected with `desktop: true` in `computer_capabilities`, and the row showed the missing login.
- Finding from the run: Debian's Chromium refuses to start without a sandbox in a container ("No usable sandbox"), so the desktop stayed `desktop: false` until `chromium-sandbox` was installed. The script now adds it when apt has it. The first with-flag run got `desktop: true` after I installed `chromium-sandbox` by hand. A second run with the final script (fresh container, new code) also reached `desktop: true`.
- The container had a fake `claude` that reports `loggedIn: false`, because the real CLI needs a login.

## Review rounds

- Round 1 at 33af232c: one must-fix (the clean-VM run was not recorded, now recorded here), seven nits.
- Round 2 on 884b1026 (the review file and a UTF-16-safe message cap): clean. Nits: the cap cuts ASCII at 1000 chars though 2000 would fit.

## Nits left

- The doctor runs before the hello on every connect, outside the stop select. A stop can wait up to the 10 s timeout, and the blocking Claude probes ignore it. Both roles run it, so a two-role machine probes Claude twice.
- `computer sudo -l` check runs on a Tokio worker without a deadline.
- `doctor::problems` repeats the check list from `run`. A new check added to `run` needs adding there too.
- `AGENTUM_DESKTOP=1` with a code that grants only `agent_host` sets the desktop flag with no computer role and says nothing.
- Ubuntu ships `chromium` only as a snap wrapper and RHEL needs EPEL for `chromium` and `openbox`. I proved only Debian. The package list matches the existing fix text in `privilege/computer.rs`.

## Ideas beyond the scope

- A machine whose Claude CLI is missing fails `prerequisites` and never connects, so its row cannot show the failure. A report over a short-lived socket or the enrol response would cover that.
- One doctor run shared by both roles.

## Checks

`bun run check`, `bun run build` (no `drizzle` in `apps/web/dist/client`) and `cargo test` pass. `bun run test` passes except the miniflare test below. The script, hello and row each have tests.

## Not verified

- Staging checks (the controller's).
- Ubuntu and Fedora installs.
- A server older than this change rejects a hello that has `doctor` (the daemon hello schema is strict), so deploy the Worker before publishing a client built from this commit.
- `bun run test` once failed `guest execution: HTTP cap/start...` (a miniflare test in live-artifacts) under load; it passes alone, with and without this change.

## Steps for Dom

- Deploy the Worker (migration 0052) before the next client release.
- None of the checks need your accounts.
