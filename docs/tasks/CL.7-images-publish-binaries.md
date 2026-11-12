---
id: CL.7
title: Image builds publish their client binaries to R2
milestone: CL
size: M
status: in_progress
depends_on: [CL.6]
branch: task/CL.7-images-publish-binaries
lane: infra
executor: claude
---

Since CL.6 the Machines page offers an update only when the machine's version is in R2 and was uploaded before the latest release. Image builds (`.github/workflows/agentum-images.yml`) build their own binaries and never upload them, so a machine on an image (bot-ccau on 0.1.0+e30f620f) is an unknown version and never gets a notice. Dom wants image builds to publish their binaries so they become known versions.

How things fit today:
- The workflow builds with `apps/agentum/scripts/build-all.sh` into `apps/agentum/dist/`, and both Dockerfiles copy `dist/agentum-linux-*`. The binary's version comes from `build.rs`: `AGENTUM_VERSION`, or `<package version>+<git short=8>`.
- `apps/web/scripts/publish-releases.ts --env staging|production` refuses a dirty tree, builds with the same script, uploads the binaries under `releases/agentum-rs/<version>/`, then always writes `latest.json` last. It uploads with `wrangler r2 object put --remote`, so it needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It skips only when `latest.json` already names the version.
- The workflow has no Cloudflare secrets. The repo has no Actions secrets at all.

So publishing from CI with the script as it is would move `latest.json` and offer every image build to every machine. It would also rebuild, so the image and R2 would hold different bytes. A second run on the same commit would overwrite the files of a release `latest.json` already lists, which breaks its sha256 check in `install-agentum.sh` and resets its upload time.

## Scope
- `publish-releases.ts` gets a binaries-only mode for CI: upload the version's binaries, never read or write `latest.json`. `latest.json` keeps moving only through the manual publish.
- It also gets a way to upload binaries already in `apps/agentum/dist/` instead of building them, so the bytes in R2 are the bytes in the images. Check each prebuilt binary is present and non-empty, and that the version comes from the same commit.
- In binaries-only mode, skip a version whose binaries already exist in that bucket. Never overwrite them.
- Workflow: build once, publish binaries-only to the staging bucket and, when chosen, the production bucket, then build the images from the same `dist/`. Add a `workflow_dispatch` input to choose the buckets: none, staging, or staging and production. The default is staging and production. Keep `workflow_dispatch` as the only trigger.
- Secrets: read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from repo secrets. If the token is missing, the publish step prints a `::warning::` and the images still build, the way `preview.yml` skips previews.
- Update the comments at the top of the workflow and the script, and the release section of the README or docs that describe publishing, to say image builds upload binaries but don't move `latest.json`.

## Check
- Tests for the helpers: binaries-only mode never touches `latest.json`, an existing version is skipped and not overwritten, a prebuilt `dist/` with a missing or empty binary is refused, and the manual path behaves as before.
- A dry run of the binaries-only prebuilt path from apps/web lists only `releases/agentum-rs/<version>/...` keys.
- `bun run check && bun run test && bun run build` pass, and the drizzle grep on `apps/web/dist/client` finds nothing.
- `actionlint` on the workflow if it is available (`bunx` or a pinned binary in user space), else a careful read in review.
- Live, after Dom adds the secrets (controller): run the workflow with staging only. The staging bucket gets `releases/agentum-rs/0.1.0+<sha>/` and its `latest.json` doesn't change. Production waits for team-lead's go.

## Dom
- Create a Cloudflare API token with Workers R2 Storage edit on `agentum-v2-files` and `agentum-v2-staging-files`. Add it and the account id as repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` on codewithpassion/agentum.

## Log
- 2026-11-13: Dom asked for it after CL.6 left image builds without a notice. Dispatched.
