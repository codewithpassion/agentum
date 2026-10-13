# Remote desktop: task list for the demo

Scope set on 2026-10-13. This is the fast path to a demo, not the full
[plan-remote-desktop.md](plan-remote-desktop.md). It covers four things:

1. Move the Go client over from the TrueForge fork.
2. Fly machines and enrollment.
3. Screenshots reach the model as an image on a message.
4. Anthropic Managed Agents only.

Cleanup comes later: golden-fixture tests, relay hardening beyond what the
client needs, the image store refactor, the lease, takeover and the Screen tab.

Source: `codewithpassion/trueforge`, branch `dom/main` at `b3aded57`.

## Go client

1. Copy `packages/trueforge-computer` into `apps/computer`. Rename the binary
   to `agentum-computer` and the env vars to `AGENTUM_URL` and
   `AGENTUM_ENROLL_CODE`.
2. Copy `protocol.ts` to `modules/computer/protocol.ts`.
3. Port `RemoteComputerDO` over `ComputerRelay`, keeping the class name and
   binding so wrangler needs no migration. Map presence to `touchHostSeen` and
   `setHostStatus`. Desktop ops pass through; no lease yet.
4. Rewrite `remote-client.ts` on `exec`, `cancel`, `file_put` and `file_get`,
   so the existing `computer_*` tools keep working.
5. Build both images (`agentum-computer`, `agentum-computer-desktop`) to ghcr.
   Replace the `computerd` workflow.
6. Check: a managed agent on a self-hosted container reads, writes and runs
   commands.

## Enrollment

7. Port `computer_enrollment` (15-minute single-use code, redeemed for a
   machine credential) and `POST /api/computer-hosts/enroll`. The credential
   hash goes in `computer_hosts.token_hash`.
8. The connect route takes the credential as a Bearer token. Re-enroll revokes
   it and closes the socket with 4401.
9. Host creation shows the code and the `docker run` command (the desktop one
   with the seccomp flag). "Rotate token" becomes "Re-enroll". Old `computerd`
   hosts get deleted and recreated, with no migration path.

## Fly

10. `onAgentComputerCreated` creates the machine from the `agentum-computer`
    image with an enrollment code in its env, and mounts the volume at the
    client's state dir so the credential survives restarts.
11. Fly can't wake an outbound-only machine on traffic. When an op hits an
    offline Fly host, start it through the Machines API and wait for `hello`.
    Idle stop can wait.
12. Delete `fly-transport.ts`, listen mode and `apps/computerd`.
13. Check: the step 6 list on a Fly-backed agent, on a real Fly account.

## Screenshots as image messages

The Managed Agents `user.message` takes image blocks with a `base64`, `url`
or `file` source (`BetaManagedAgentsImageBlock` in the SDK). We use `url` with
a signed attachment link (`attachment-links.ts`), so no image bytes go through
the event.

14. `gateway.sendMessage` accepts text plus image blocks.
15. The screenshot tools store the JPEG or PNG in R2 `ATTACHMENTS`, then send
    the agent's running session a `user.message` with the image and a one-line
    caption. The tool result says the screenshot follows as the next message.
16. `browser_screenshot` uses this path.
17. New `computer_screenshot` sends `desktop_screenshot` through the relay and
    delivers the image the same way. It's offered only when the host reports
    `capabilities.desktop`.
18. Check: a managed agent on the desktop image describes its screen. If the
    image only lands after the turn ends, change the tool result to tell the
    agent to end its turn and continue when the image arrives.
