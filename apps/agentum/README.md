# Agentum machine client

Agentum connects a Linux machine to Agentum as an agent host, a computer, or
both. One enrolment supplies both roles, and one service keeps them connected.
The agent host drives an installed Claude CLI; the computer role runs shell
commands and transfers files, with an optional Xvfb desktop.

## Install and enrol

Use Linux x64 or arm64 with systemd. Install the `agentum` binary on PATH.
To build it from this checkout, run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd apps/agentum build:release
install -Dm755 apps/agentum/target/release/agentum ~/.local/bin/agentum
```

An agent host needs Claude CLI 2.1.300 or newer, installed and logged in as the
user that will run agents. Desktop mode needs Xvfb, openbox, xdotool, xclip and
Chromium. `agentum doctor` gives package installation and permission fixes.

Create an enrolment code on the Machines page, choosing the roles there. Enrol
before installing the service. Paste the code on stdin so it stays out of the
command line:

```sh
agentum enroll --url https://agentumbot.io --code-stdin --name office
agentum service install --user --instance office
agentum status --instance office
```

`AGENTUM_ENROLL_CODE` is another code input; Agentum removes it from its environment
after reading it. The code chooses the roles. `--name` is optional: otherwise the
server's machine name becomes the instance name, with a numeric suffix on clash.
An explicit name must be unused. Names contain lowercase letters, digits and
hyphens, up to 40 characters.

The user service uses your systemd user manager. Installation checks the session
bus and offers to enable lingering so the service starts at boot and survives
logout. `--yes` skips confirmation, including the linger prompt. No terminal
means the explanation is printed without prompting. Run `agentum run --instance
office --log-format text` to run in the foreground instead.

## Choose who runs agents and computer commands

Choose the same mode at enrolment and installation. A change between single-user
and agent-user mode needs a fresh enrolment because the server decides which
credentials to supply from that choice.

| Mode | Meaning |
| --- | --- |
| `current` | Default for a user service: your own account, Claude login and settings. Agents and computer commands can read and change everything you can, including SSH keys and the machine credential. Under sudo, `current` resolves to `SUDO_USER`. A system install without an invoking user uses the instance service account. |
| `<user>` | An existing named account, for a system service. The service, agents and computer commands run as that account, including access to the machine credential. Root installs the service. |
| `agent-user` | System service with separate `agentum-<instance>-svc` and `agentum-<instance>` accounts. The service owns the credential; agents and computer commands run as the agent account with a separate home and work tree. They cannot read the service's private credential directory. Root installs the accounts and a scoped sudoers rule. |

For a system install, an administrator must first place Agentum in a root-owned
location such as `/usr/local/bin/agentum`. Its resolved binary and every parent
directory must be root-owned, executable/traversable and writable only by root.
Claude must also be accessible to the selected agent account, rather than in
someone else's private home. For example, an administrator can run:

```sh
sudo agentum enroll --system --run-as agent-user --name office \
  --url https://agentumbot.io --code-stdin
sudo agentum service install --system --run-as agent-user --instance office \
  --claude /usr/local/bin/claude
```

Set up Claude's login for `agentum-office` before expecting agent-host runs to
succeed. The sudoers drop-in permits Claude with `SETENV` and a chosen workdir,
work-file utilities, and only the fixed `agentum --computer-worker` entry point
for the computer. It disables `requiretty` and `use_pty` for the service account
so the worker's piped JSON input is preserved. If host policy overrides those
settings, use `visudo` to set `Defaults:agentum-office-svc !requiretty, !use_pty`
after that policy and restart the instance.

## Several instances and local files

Enrol again with a separate code and name, then install that instance's service.
Always pass `--instance <name>` when several are installed; omitting it lists the
choices. `agentum list` or `agentum list --json` shows the instances, roles and
last recorded service/connection state.

User config lives in `$XDG_CONFIG_HOME/agentum/<instance>` (default
`~/.config/agentum/<instance>`), and state in
`$XDG_STATE_HOME/agentum/<instance>` (default `~/.local/state/agentum/<instance>`).
`AGENTUM_CONFIG_DIR` and `AGENTUM_STATE_DIR` override the respective roots, with an
instance directory below each. System instances use `/etc/agentum/<instance>`
and `/var/lib/agentum/<instance>`. Config and credential are separate private
files. Each instance has its own `agentum-<instance>.service` and work tree.

Computer policy flags such as `--read-only`, `--workdir-only`, `--allow`, `--deny`,
`--allow-env`, `--max-*`, `--audit-*` and `--desktop` can be supplied at service
installation and are saved in config. Flags on `run` apply to that run; `--save`
persists them. Running computer commands as root requires `--allow-root`.

## Diagnose and manage the service

```sh
agentum doctor --instance office
agentum service status --instance office
agentum service logs --instance office -f
agentum service restart --instance office
agentum status --instance office --json
```

Doctor reports filesystem privacy, systemd, the user bus and lingering, Claude
version/access and login, computer prerequisites and server reachability. Areas without
an enrolled role are shown as skipped. It changes nothing and does not open a
role socket, which would replace a running connection. Claude version and login checks
run bounded non-conversation probes.
Run logs are JSON on stderr by default; journald keeps them. `--log-format text`
is useful at a terminal. Computer commands have a separate rotating audit log.

To uninstall a service:

```sh
agentum service uninstall --instance office
```

System service operations require root. Uninstall stops and disables the unit
and removes its sudoers drop-in. It keeps enrolment, state, accounts and lingering.
Revoke the machine on the Machines page when retiring it; retain or remove its
local data according to your needs.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, or stopped by SIGINT/SIGTERM |
| 1 | Runtime failure |
| 2 | Invalid command or flags |
| 3 | Credential rejected; enrol again with a new code |
| 4 | Not enrolled |
| 5 | Missing permission or prerequisite; follow the printed fix |

Units prevent restarts on exits 2, 3, 4 and 5. Network errors reconnect with
backoff. A missing prerequisite disables its role while the other role can keep
running; exit 5 applies when no role can start. Revocation on either socket
stops both roles with exit 3.

## Development checks

From the repository root, run `bun run check && bun run test`. Direct Rust
commands go through `bash apps/agentum/scripts/cargo.sh`, which also works around
the host compiler shim. Tests use fake servers and fake Claude processes. The
real Claude conformance test runs only with `AGENTUM_CLAUDE_E2E=1`; ordinary tests
never spend Claude tokens. See [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries
and the executor regression coverage.
