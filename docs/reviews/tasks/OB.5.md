# OB.5: agent-desktop as an opt-in Linux desktop backend

## Verdict

Clean after 1 fix round.

- Round 1 (918e264e): not clean. One must-fix. The audit hid typed text in a `desktop_act` error only by replacing the raw text, so a JSON-escaped copy in agent-desktop's `details`, or a copy cut at the 1000-character message limit, got through. Fixed in e7e1a3b4: the audit keeps only agent-desktop's error code for a refused action.
- Round 2 (e7e1a3b4, fix commit only): clean, three nits. Two were fixed afterwards (the code check now fails closed, and one test skips without `dbus-daemon`).

## What changed

The ops `desktop_snapshot`, `desktop_act` and `desktop_apps` are typed ops in `packages/protocol/src/computer.ts`, in `DESKTOP_OPS` so they take the desktop lease. The relay also refuses them with `desktop_unavailable` unless the computer's hello said `agent_desktop`, so an older client never gets an op it would answer with `unknown_op`. The MCP tools are `desktop_apps`, `desktop_snapshot`, `desktop_act` and `desktop_act_headed`. They exist only when the machine reports `agent_desktop`. All four are on the assistant's excluded list.

On the machine (`apps/agentum`), everything is off until `--allow-app <name>` names an app (`ComputerConfig.allow_apps`, empty means off). Every policy refusal happens before a process starts:

- A snapshot with no app, or an app outside the list, is `denied`. A `root` ref must come from a snapshot of the same app.
- `desktop_act` takes a fixed action list and a ref that must match `@s<id>:e<n>`. The server remembers which app each snapshot read (256 entries, oldest out), and an action is checked against that app and the list again. An unknown snapshot is `denied`.
- `read_only` refuses `desktop_act` and still allows snapshots.
- `headed` is refused unless the computer was started with `--allow-headed`.
- Typed text goes to agent-desktop on stdin (`type`, `set_value`), never argv. A `select` value goes after `--`.
- A snapshot answer that names another app than the one asked for is refused and not remembered. `desktop_apps` shows only allowed apps.
- The audit records `app`, `ref`, `action`, `typed` (a character count) and `headed`. It never records the text, and for a refused action it keeps only agent-desktop's error code.

`desktop.rs` starts one session bus per desktop at a fixed path in the desktop's private directory, and passes `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` to the window manager and to every command, `exec` included. With the opt-in on it also sets `ACCESSIBILITY_ENABLED=1` and `CHROMIUM_FLAGS=--force-renderer-accessibility`. `Dockerfile.desktop` adds `dbus`, `dbus-x11`, `at-spi2-core` and agent-desktop 1.2.0 for amd64 and arm64, pinned by sha256 with `ADD --checksum` (no curl in the image).

For ask-before, `harbourmaster/desktop_act` and `harbourmaster/desktop_act_headed` are gateable actions with labels. They ask at every ask level for an agent whose computer reported `agent_desktop`, until a rule on the action says allow. See the interpretations below.

## Interpretations I made

- "Gated by default" and "headed denied by default": `TOOL_RULE_MODES` has only `ask` and `allow`, and the default level `rarely` asks about nothing. I made the two desktop actions ask by default only for an agent whose attached computer allows apps (`desktopAsksByDefault` in `requests/ask-keys.ts`), so no other agent's ask keys changed. Headed is two things: its own tool and ask key, and a machine-side refusal unless `--allow-headed`.
- `desktop_act_headed` is a second MCP tool on the same `desktop_act` op with `headed: true`, because a run gates by tool name and a key needs a tool of its own.
- The session bus starts whenever `dbus-daemon` exists and is required only with the opt-in, so a desktop on a host with no bus still launches.
- The new capability `agent_desktop` is optional in the hello and the Rust client sends it only when true, so the frozen fixtures in `apps/computer/testdata` still round-trip unchanged.
- I did not edit the Chromium wrapper in `apps/computer/packaging/desktop`, which CL.1 may move. The wrapper passes through the `CHROMIUM_FLAGS` that Debian's `/usr/bin/chromium` reads, and the Rust side sets it only with the opt-in.

## Beyond the brief's directory list

The brief said to stay in `apps/agentum`, `packages/protocol` and `packages/mcp`. The ports and the relay are named methods with no generic request passthrough, so the new ops also touch `apps/web/src/server` (relay core, relay, relay port, computer ports, MCP route) and `packages/services` (`machines/types.ts`, `machines.ts` stores `agentDesktop`, and the ask-before files). One relay method, `desktopApp`, carries all three ops.

## Nits left

- `askBefore` lists the two desktop rows for every agent, including one with no computer or a computer without apps.
- A daemon run fixes its `toolRules` at claim time. If an owner restarts a computer with `--allow-app` mid-run, `desktop_act` is listed for that run and the daemon does not ask until the next claim.
- With the opt-in off, a bus that starts but never answers in 10 seconds is left running under supervision, and startup waits the full 10 seconds.
- `exec` is not limited by the app list. A shell command can still run agent-desktop itself, so keep `computer_exec` behind Ask before. The README says so.
- The audit keeps the plain message for a refused `desktop_act` that has no `CODE: ` prefix. Those are our own fixed strings.
- `cargo clippy --all-targets` reports five warnings in test code I did not touch (`tests/enroll.rs`, `runs`, `privilege/agent.rs`, `worker.rs`). The repo's check runs plain clippy, which is clean.

## Ideas beyond scope

- A snapshot per agent turn (agent-desktop `--session`), so refs from one turn cannot be used in the next.
- Tell the agent in the computer instructions in `packages/protocol/src/attachments.ts` when apps are on and when to prefer a snapshot over a screenshot.
- Show on the Machines page that a computer allows apps.
- Move the agent-desktop version and checksums into one file that both Dockerfiles read.

## What I could not verify

- Staging checks, which are the controller's.
- arm64: the image build selects the aarch64 archive by its checksum, but I built and ran amd64 only.
- Apps other than Chromium, GTK4, Qt, Electron and Wayland.
- A model driving the loop. The run below played the agent by hand.
- Long-running memory and speed with Chromium accessibility on.
- The Debian `/usr/bin/chromium` wrapper reading `CHROMIUM_FLAGS` is shown by the run (the flag was on the process list), not by a unit test.

## Checks run

- `bun run check`, `bun run test` and `bun run build` pass, and `apps/web/dist/client` holds no `drizzle`. `cargo test` and `cargo clippy -- -D warnings` in `apps/agentum` pass (158 library tests).
- The OB.4 "Hello, Ada" run through the real `agentum --computer-worker`, in the desktop image built from this branch (seccomp profile, `--cap-drop ALL`, `--cap-add SYS_CHROOT`, `no-new-privileges`). The driver is `/home/roboto/devel/harbourmaster-wt/tmp/OB.5/e2e/run.ts` and it passed 23 of 23 checks. With `allow_apps: ["chromium"]` and `allow_headed`:
  - `desktop_apps` lists chromium, a snapshot with no app, an app outside the list and an unknown snapshot are `denied`.
  - A scoped snapshot is 13 KB for 79 refs. Headless `type` on the page's text field is refused by the page (`POLICY_DENIED`), headed `type` works, and `click` on Greet works headless.
  - A snapshot rooted at the page's web area reads "Hello, Ada" in 1.3 KB.
  - The audit entry for the typed action holds `typed: 3` and no "Ada".
  - With no `allow_apps` the three ops are `denied`, the hello carries no `agent_desktop`, and screenshots work as before. With apps but no `allow_headed`, a headed action is `denied`.

## Steps for Dom

None need your accounts. To try it on a machine, restart its computer with `agentum run --desktop --allow-app chromium --allow-headed` (or install the service with the same flags), then give an agent that computer and ask for a task in the browser. The desktop image has to be rebuilt and released for the new binaries to be in it. Pushing is yours and the controller's.
