# OB.4: agent-desktop as a second desktop backend

Spike. No product code changed, so there are no failing tests to write first. The only file in the diff is this one.

## Recommendation

Go, on Linux only, as an opt-in second backend next to the pixel one. No-go on macOS until someone runs it on a Mac.

Confidence is medium-high that it works. It is low-to-medium that it is worth building, because the token saving only shows up when a snapshot is scoped to one page, and the commonest web action (typing into a field) still needs physical input.

AT-SPI works in the current desktop image. The image is Debian bookworm with at-spi2-core 2.46, run with the shipped `seccomp.json`, `--cap-drop ALL`, `--cap-add SYS_CHROOT` and `no-new-privileges`. agent-desktop's own guide asks for Ubuntu 24.04 or a newer at-spi2-core bridge. That did not bite on bookworm with the two apps I tried.

## What I ran

Evidence is in `/home/roboto/devel/harbourmaster-wt/tmp/OB.4/` (`logs/`, `scripts/`). I downloaded agent-desktop v1.2.0 (Apache-2.0, x86_64 Linux archive, checksum verified) into that folder and built a throwaway image `FROM agentum-rc6:desktop` that adds `dbus`, `dbus-x11`, `at-spi2-core`, `python3-minimal` (for JSON parsing in my scripts) and the two agent-desktop binaries. Nothing was installed on the host.

The real task, in both backends, was the same. Open a local page with a text field, a Greet button and a status line. Type "Ada", press Greet, confirm the page says "Hello, Ada". Both runs went through the real `agentum --computer-worker` (the Rust client from that image), which starts Xvfb :151 and openbox and passes the Chromium sandbox self-test. A small driver fed it frames over stdio. The container's `/tmp/replies.jsonl` died with the container, so the worker frames and audit entries I saw are copied under "Recorded worker frames" below. The driver is `scripts/driver.py`.

Pixel backend. `exec` to start Chromium, `desktop_screenshot` (q60, 1280x800, 48.6 KB), `desktop_input` with click, type, click (audit entry lists `["click","type","click"]`), then a second screenshot (`logs/pixel-1.jpg`, `logs/pixel-2.jpg`). I read coordinates off the first screenshot and the second shows "Hello, Ada". Three desktop frames, two images.

AT-SPI backend. agent-desktop ran through the same worker's `exec` op, with `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` and `ACCESSIBILITY_ENABLED=1` passed as env. Chromium started with `--force-renderer-accessibility`. `find` returned refs for "Your name" and "Greet". Results, in order:

- `click @ref` on Greet worked headless (`Action.DoAction`, semantic).
- `type @ref` on the field failed with `POLICY_DENIED supported_action`. `set-value` failed with `ACTION_NOT_SUPPORTED`. Chromium page text fields expose no semantic write.
- `--headed type @ref "Ada"` worked, `delivered_verified`, but through `XTEST.type_text`, which is physical X input.
- A final `find --text Hello` read back "Hello, Ada" and the field value "Ada". No screenshot needed.

Other measurements:

- `status` reports `granted` and surfaces `window, sheet, alert, menu`. `list-apps` shows only `chromium`. xterm and tint2, which the current desktop session starts, never appear, because they are not AT-SPI toolkits. The pixel backend still covers them.
- A GTK3 app (mousepad) on bookworm under the same hardened flags: 271 refs, headless `type` through `EditableText.InsertText`, verified (`logs/step1-bookworm-gtk3.log`). So the old-bridge abort named in the guide did not show.
- Without the bus env, an exec'd `agent-desktop` fails with `PLATFORM_NOT_SUPPORTED`, "no D-Bus session bus is reachable" (`logs/policy-allowlist.log`).
- The shipped seccomp profile blocked nothing I could see. I show that by success, not by strace.
- Chromium needs both `--force-renderer-accessibility` and `ACCESSIBILITY_ENABLED=1`. Without the second, it never joins the bus in this container, as the guide says.

## Recorded worker frames

Pixel run, audit entries as the worker emitted them:

```
{"audit":{"op":"exec","request_id":"p1","cwd":"/tmp/work","command":"nohup chromium --no-first-run --user-data-dir=/tmp/cp-pixel file:///work/form.html >/tmp/chromium-pixel.log 2>&1 &\nsleep 1; echo started","outcome":"ok","exit_code":0,"bytes":8,"truncated":false,"duration_ms":1003}}
{"audit":{"op":"desktop_screenshot","request_id":"p2","outcome":"ok","bytes":64800}}
{"audit":{"op":"desktop_input","request_id":"p3","outcome":"ok","actions":["click","type","click"]}}
```

The first reply to the driver was `{"ready":{"capabilities":{...,"desktop":true,"desktop_unavailable_reason":null},"workdir":"/tmp/work"}}`, so the Chromium sandbox self-test passed. The p3 reply was `{"id":"p3","result":{"ok":true}}`. The p4 screenshot is `logs/pixel-2.jpg`.

AT-SPI run, first call and its audit entry (the later calls, a2 to a7, saved their stdout as `logs/a*.out`):

```
{"op":"exec","request_id":"a1","cwd":"/tmp/work","command":"nohup chromium --force-renderer-accessibility ... &\nsleep 8; agent-desktop list-apps","outcome":"ok","exit_code":0,"bytes":166,"duration_ms":8019}
```

The a6 audit entry carries the full command, including the typed text. That is why secrets cannot go through `exec`.

## Token cost

Image tokens use width x height / 750. Text tokens use bytes / 4, with bytes / 3 as the upper end, because dense JSON tokenises worse than prose. These are estimates from byte counts. I did not send them to a model.

| Observation | Bytes | Tokens |
|---|---|---|
| Screenshot, q60, 1280x800 | 48.6 KB JPEG | about 1,365 |
| Chromium, full snapshot | 23,252 | 5.8k to 7.8k |
| Chromium, `-i --compact`, whole browser | 13,126 | 3.3k to 4.4k |
| Chromium, `--root` on the page's web area | 747 | about 190 to 250 |
| mousepad, `-i --compact` (271 refs) | 46,387 | 11.6k to 15.5k |

A whole-window snapshot costs more than a screenshot once it passes about 5.5 KB. Most of that Chromium snapshot is browser chrome, not the page. A scoped snapshot is about 5 to 7 times cheaper than an image. The whole task by finds and acts returned about 3 KB (roughly 800 tokens) against two screenshots at about 2,700. A model that snapshots whole GTK apps would pay several times the pixel cost. Snapshots also leave out static text unless asked: the "Hello, Ada" line is not in the `-i` tree, so the check used `find --text`.

Time: each agent-desktop call took 15 ms to 1 s warm. The headed `type` run took about 3 s with its lookups.

## How it maps onto the computer protocol

The shape is two or three typed ops, not exec. Both live in the existing `op.starts_with("desktop_")` arm in `computer.rs`, handled by `desktop::dispatch`.

- `desktop_snapshot { app, root?, interactive, compact, skeleton? }` returns `{ snapshot_id, ref_count, complete, text }`, where `text` is the JSON. It runs agent-desktop through the same `command()` and `run_helper(..., cap)` the xdotool calls use, with a deadline and an output cap (the existing `too_large` fault covers a runaway tree). `computer.rs` already records `bytes` from a `text` field, so the audit entry gets a size and never the body.
- `desktop_act { ref, action, text? }`, with `action` from a fixed list (`click`, `set_value`, `type`, `toggle`, `select`, `expand`, `collapse`) and `text` capped at 512 characters like `type` is today. The ref must match `^@s[a-z0-9]+:e[0-9]+$`. Add `headed` as a separate boolean, default false.
- `desktop_apps` for `list-apps`, if the agent needs names.
- `read_only` refuses `desktop_act` the way it refuses `desktop_input`. Snapshots stay allowed, like screenshots and clipboard reads.
- `Policy` gets `allow_apps`. A snapshot with no `--app` is always refused, since it would read every app. A server-side map from `snapshot_id` to app lets `desktop_act` re-check the app, since a ref names only its snapshot. An unknown snapshot id is refused. A refusal uses the existing `denied` code, which the audit already records as outcome `denied`.
- Audit adds `app`, `ref`, `action` and the typed character count. Typed text is never logged, as `desktop_input` already does not. The `exec` route does log it (the command line holds "Ada"), so a password cannot go through `exec`.
- `validate_actions` bounds of 1280x800 still apply to any coordinate fallback.
- The `d.turn` semaphore applies unchanged, because `dispatch` takes it for every op but screenshots. Desktop leasing (`desktop_busy`, person-holds-desktop) does not come free. The web relay decides it through `isDesktopOp`, which checks the fixed `DESKTOP_OPS` set in `packages/protocol/src/computer.ts`, not the `desktop_` prefix. Every new op must be added to that set or it runs with no lease. Refs live in agent-desktop's state dir, which it requires to be mode 700. Put it under the desktop's private dir, one per desktop.
- Protocol: three zod ops in `packages/protocol/src/computer.ts`, tools in `packages/mcp/src/tools/computer.ts`. For ask-before the key would be `harbourmaster/desktop_act`, next to `computer_exec` in `ask-before.ts`.

The no-code route does work. `exec` ran every call above, and policy and audit applied. It is a pilot path only, for two reasons I tested with a worker configured (config passed to the driver, not saved in a log; only the `; id` result is in `logs/policy-allowlist.log`, and I did not exercise the `--headed` deny) `allow: ["agent-desktop (list-apps|find|snapshot|click)( .*)?"]`, `deny: ["--headed"]`:

- The allow regex matches the whole shell string, so `agent-desktop find --role button; id` was allowed and ran `id`. A per-app allow list cannot be a shell regex.
- With any restriction set, env vars are refused unless listed in `allow_env`, so the bus address needs `--allow-env`.

## What the integration needs in `desktop.rs`

- A session bus per desktop. `Desktop::command` clears the environment, so today nothing carries a bus address. Start `dbus-daemon --session --print-address` in `launch`, add the address to `environment()` beside `DISPLAY` and `XAUTHORITY`, and everything the WM starts, plus every exec'd command, joins the same bus. (`dbus-x11` autolaunch keyed on the display is an alternative I did not test.)
- Image: add `dbus`, `dbus-x11`, `at-spi2-core` and the two agent-desktop binaries (7.2 MB plus 0.6 MB, glibc-linked, fine on the Debian image). Pin the checksum. Also add to the missing-binary check in `launch`.
- `apps/computer/packaging/desktop/chromium` (the wrapper `Dockerfile.desktop` copies in) adds `--force-renderer-accessibility` and sets `ACCESSIBILITY_ENABLED=1`. That turns accessibility on for every Chromium on the desktop, which costs some speed. Make it follow the opt-in.
- Release builds are static musl, x86_64 and aarch64 (`apps/agentum/scripts/build-all.sh`). The agent-desktop aarch64 archive exists. I built and ran x86_64 only.

## Ask-before and allow list it would need

- `desktop_act` gated by default for any agent. The ask levels ("Ask before it acts outside" and the others) come from AB.1, which is still in progress, so this depends on it. Snapshots are not gated, but they can expose private text, and GTK4 entries show their text even when hidden (the guide says so; only a password role is withheld).
- Allow list as `list-apps` names (`chromium`, `mousepad`), set per computer in `ComputerConfig`, empty meaning no agent-desktop at all.
- `headed` on its own ask key and denied by default. It is XTEST physical input into the private Xvfb, the same class as `desktop_input` today. Chromium text entry needs it, so in practice it will be on for web work.

## Risks

- Young project. v1.0.2 shipped 30 Oct and v1.2.0 on 5 Nov. Its Linux guide measures GNOME on Ubuntu 24.04. I measured openbox on bookworm with two apps.
- Refs need a unique identity. Two identical buttons give `AMBIGUOUS_TARGET`, and the fallback is a headed click by coordinates.
- Apps that are off the bus (xterm, tint2, Qt without `QT_ACCESSIBILITY=1`, Electron save dialogs, canvas content) need the pixel backend anyway. The agent needs both and a rule for choosing.
- The docs say the macOS path "was not run for these docs".

## macOS

Not tested here. `Desktop::start` refuses non-Linux, and Agentum ships only Linux musl binaries, so a Mac needs a new release target, a launchd service path and its own privilege handling, before any desktop work. For agent-desktop on a Mac there is no Xvfb: it drives the logged-in user's real session through the AX API. The Accessibility grant belongs to the app that launches it (the agentum binary or its host), is given in System Settings, and cannot be given from a headless service. Screenshots need Screen Recording. That is a different product from a private virtual desktop, because the agent shares the user's screen, so the per-app allow list becomes the main control. I would not start before a Linux version has shipped and someone has run agent-desktop on a Mac.

## Not verified

- Staging checks, which are the controller's and none exist for a spike.
- Ubuntu 24.04 or 22.04 as the base. Bookworm worked, so I did not need the comparison.
- GTK4, Qt, Electron, Firefox, Wayland, arm64.
- A model driving the loop. I played the agent. Token figures are byte-based estimates.
- Long-running stability and memory with accessibility on in Chromium.
- The seccomp profile by strace. It passed by running.

## Review rounds

Round 1 (aceb748): not clean. Two must-fix. The lease claim was wrong, since `isDesktopOp` checks a fixed op set, and the doc promised excerpts it did not hold. Fixed in 1b67885.

Round 2 (1b67885, fix commits only): clean.

Checks: `bun run check` and `bun run build` pass, and `apps/web/dist/client` holds no `drizzle`. `bun run test` failed once per run on a different heavy test (live-deck, a 60 s services timeout, then the Miniflare guest-execution test with `ECONNRESET`) while the host load average sat at 12 to 15. Each passed when run alone (live-deck 64 pass, services 4123 pass, the guest-execution test 1 pass in 77 s). The diff touches only this file.

## Nits left and ideas beyond scope

Nits left: the a1 audit excerpt is shortened with `...` and omits `"truncated":false`. The recorded-frames section shows p1 to p3 audit entries but not p4's.

Ideas beyond scope: a `--session` per agent turn, so refs from one turn cannot be used in the next. A second spike on Qt and GTK4 apps. Passing the bus through `dbus-x11` autolaunch instead of an explicit address.

## Steps for Dom

None need your accounts. The decision is whether to schedule the Linux implementation task described above.
