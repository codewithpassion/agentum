# B.1 review

Task: phase 2 spike (Dynamic Workers, AppStore vs Facets) and subdomain review. Output: `docs/v3/phase2-spike.md`.

## Round 1, commit 3eea073 (Opus reviewer)

Verdict: not clean, 2 must-fix. The reviewer also ran its own spot-check on `wrangler dev`: an HM stub kept in module state fails on a later request (`Cannot perform I/O on behalf of a different request`), so the per-request stub design holds. It judged `AppStore` and the HM interface sound for R2.1 to R2.6.

Must-fix, applied in fd34c77:
- The cached loader config baked the approved hosts into `globalOutbound`, so later approvals or rejections would not apply. `AppOutbound` now reads the hosts per request.
- Link viewers calling `HM.callTool` had no visitor metadata for R2.13 and R2.14. `AppHostProps` now carries `meta` (`AppRequestMeta`), and the link path goes through B.6's `ShareGrant` entry.

Nits fixed: harness and class names, `connect()` evidence, default-export check at publish, not-run labels, facet cause, cap counting and `wipe`, `Cache-Control` overwrite, rate-limit binding note, read policy, per-request share re-check, R2.8 verdict wording, open questions for Dom.

Nits left: bold-label bullets in a few places (writing style); the stored-stub residual case is described, not mitigated; vite-dev results were read from curl output and no response bodies were saved.

## Round 2

Not run. The round 1 fixes are documentation only and each traces to a finding, and Dom needs the doc tonight. The controller can start a re-review on fd34c77 if wanted.
