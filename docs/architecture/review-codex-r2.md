# Codex adversarial review, round 2 (16 Oct 2026)

Run with the revised pages inlined as text, because the Codex repo sandbox (bwrap) failed on this host. Source repos were not re-checked in this round.

**Verdict: not ready to start M0 as specified.** The revision closes many first-round findings, but several claimed fixes remain incomplete, including mechanisms frozen by C1, C4 and C6.

The fixes for connector assignment, header-credential ownership, workspace-based paths, injected service dependencies, org membership checks, deploy lifecycle handling, dev-login setup and explicit deferrals are reflected in the revised pages. The remaining issues follow.

### High

1. **Conditional writes do not serialize rotating-token refreshes — C-H3 remains open.**

   **Pages:** `index.html`, seam 4; `build-plan.html`, M3.3; `review-response.html`, C-H3.

   Both callers can send the same refresh token upstream before either performs its conditional write. A database version check protects persistence, but cannot prevent the second upstream refresh from failing—or invalidating the token family. A failed caller can also mark `needs_auth` before the successful caller commits. The specified mechanism cannot satisfy “exactly one refresh.”

   **Fix:** Acquire a credential-level refresh lease atomically *before* contacting the provider. Waiters re-read after the lease holder finishes. Fence successful and failed writes against both the credential version and lease ownership; re-authentication and revocation must invalidate outstanding refresh ownership. Test both orderings of success and failure, not just the final row version.

2. **Heartbeat renewal does not update the running SDK’s MCP credentials — m17 is only partially fixed.**

   **Pages:** `index.html`, seams 3–4; `build-plan.html`, C4, C6, M1.4.

   `query()` receives an `mcpServers` map containing the initial token. Heartbeat returns a new token, and the daemon “adopts” it, but no mechanism updates the HTTP transports already created by `query()`. Once the initial lease expires, a healthy long run can lose both connector access and platform MCP access. Updating a daemon variable does not establish transport renewal.

   **Fix:** Before freezing C4/C6, either demonstrate supported live header replacement or use one stable execution token whose authorization depends on the current running row and lease. Give it an explicit maximum execution lifetime. Add a live SDK test that calls both MCP endpoints after the initial lease duration has elapsed.

3. **The human-subject chain cannot pass through the declared reply gateway — B1 is not fully closed.**

   **Pages:** `index.html`, seams 1 and 5; `build-plan.html`, M0.4, M6.1.

   M6.1 requires an agent reply post to carry its originating `run_id`, but `Gateway.deliver(target, { text, fileIds })` supplies neither the run ID nor a trusted posting principal. The inbox gateway therefore cannot implement the promised inheritance through this interface.

   Separately, `startRun` accepts an `actor`, and its derivation checks a user actor before the run principal. Without an explicit caller-to-actor invariant, an internal caller can override the subject instead of inheriting it.

   **Fix:** Pass trusted completion context, including `runId`, into gateway delivery. Derive direct actor and human subject from the authenticated principal; a run principal must always inherit its stored subject. Persist agent-post provenance server-side and validate any supplied parent reference. Test the full user → A → reply post → B path through `completeRun` and the real inbox gateway.

4. **Interruption fences database writes but does not preserve the promised execution serialization.**

   **Pages:** `index.html`, seams 1–3; `build-plan.html`, M1.3–M1.5.

   Not requeuing an expired run is a sound improvement, and attempt IDs are unnecessary if a run never restarts. However, “one run per agent” is enforced only by the daemon. The claim predicate allows two different runs for the same agent to become running. A replaced daemon connection also does not establish that its Claude process stopped.

   After interruption, Retry creates another run even though the old process may still be operating on the same files or external systems. Rejecting its late completion does not stop those effects.

   **Fix:** Enforce one active execution per agent in database admission, and distinguish an unknown execution outcome from confirmed process termination. On lease-renewal failure or connection replacement, abort the local process; do not release its local execution slot until termination is confirmed. Define Retry’s outcome-unknown behavior explicitly. Test two claimers and a partitioned process that remains alive after interruption.

5. **Durable admission has no specified recovery dispatcher — C-H5 and C-H6 are only partially closed.**

   **Pages:** `index.html`, seams 1 and 5, MachineRelay description; `build-plan.html`, M1.1, M4.2, M5.1.

   The batches fix the original dedupe/run and schedule/run loss windows. But a crash after admission and before dispatch leaves durable work without a defined recovery path. M4.2’s acceptance check says “the next tick dispatches” that run, while the tick’s scope only selects due triggers; its schedule has already advanced. Slack has the same post-commit window. Reconnect recovery for missed offers is also unspecified.

   **Fix:** Make queued runs the recoverable dispatch source. Assign one owner to sweep eligible queued work and offer it on machine connection and periodically thereafter. Dispatch must tolerate duplicate offers. Specify duplicate-key handling explicitly: a uniqueness violation is not automatically a successful no-op. Add post-commit/pre-dispatch crash tests for both Slack and routines.

### Medium

6. **C1 and C4 cannot carry the specified file flow.**

   **Pages:** `index.html`, run data model and machine protocol; `build-plan.html`, C1, C4, M1.6, M5.3, M7.1.

   `StartRunInput` accepts `fileIds`, but the run schema has nowhere to persist them. Completion accepts no `fileIds`, despite M1.6 returning attachments through completion and gateways expecting them. Files uploaded before a new chat run also need a defined association with the session that a run token is later allowed to access.

   **Fix:** Add durable input attachment references and completion attachment IDs to the frozen contracts. Define attachment ownership and session binding before admission, then test upload → queued run → daemon download and daemon upload → completion → Slack delivery.

7. **The lanes remain coupled through unfinished shared services and composition.**

   **Pages:** `build-plan.html`, Contracts, lane table, M0.7, M2.1, M3.3, M9.

   Splitting route files reduces merge conflicts, but does not make the lanes independent. Runtime depends on Access’s principal implementation and `mcpServers` builder. Both Access and Automation consume changing runs and gateway contracts. Access also owns settings and connector pages while Automation nominally owns later UI pages. Dependency injection makes testing cleaner, but the composition owner that installs those dependencies is unspecified.

   M0 additionally permits principal bodies to return null while requiring every prefix to resolve, and tests heartbeat-minted tokens before the heartbeat route exists.

   **Fix:** Describe these as coordinated lanes. Give shared runs, principal resolution and application composition explicit owners; freeze minimal callable interfaces or provide working fakes before consumers start. Resolve UI ownership. Separate M0 contract tests using injected fixtures from later route integration tests, with explicit prerequisites.

8. **Slack files conflict with “the batch must be the only work before 200.”**

   **Pages:** `reuse.html`, Slack dedupe row; `build-plan.html`, M5.1 and M5.3.

   The run must durably contain file references, but inbound Slack files require authenticated downloading and R2 storage. Doing this before acknowledgment adds potentially slow network operations; doing it afterward allows the run to start without its attachments. No durable attachment-preparation state or recovery owner is defined.

   **Fix:** Persist Slack file descriptors with the admitted work and defer execution until attachment preparation finishes. Reuse the recoverable dispatcher from finding 5, with explicit preparation failure behavior. Test acknowledgment followed by process loss during download.

### Low

9. **Some “runnable” checks still contradict the planned build order.**

   **Pages:** `build-plan.html`, M1.2, M2.3, M4.2, O.1, Suggested order.

   M1.2 checks the Machines page before M1.5 creates it. M2.3 expects an inbox result “within `waitMs`” without specifying a waiting inbox tool. M4.2’s required live check uses the scheduled-handler URL that M0 correctly relegates to an optional probe. O.1 says `curl localhost/... against staging`. The solo order also places staging after Slack’s required live install check.

   **Fix:** Correct the targets and prerequisites, specify polling where needed, and put O.1 before the first required public-URL check. These are documentation fixes, but “every check is runnable” is currently overstated.

10. **M0 still front-loads optional product surface for an owner-first v1.**

    **Pages:** `build-plan.html`, C1, C6, M0.2, M0.6; `index.html`, Slack scope.

    Freezing every feature table and all nine MCP tool schemas before the machine skeleton proves useful retains much of the original coordination cost. The serial migration rule already provides a safe way to add later tables. The new Slack manifest API flow also remains mandatory after a sufficient paste flow works.

    **Fix:** Freeze the foundation’s tenant and execution invariants at M0; add later feature tables and tool schemas with their milestones. Make manifest API creation an optional follow-up after the paste flow has been used successfully. The managed-runtime and release-pipeline deferrals are appropriate and need no further expansion.