# C.7 review notes

Skills and files for cloud runs. Branch task/C.7-cloud-skills-files.

## Verdicts

Round 1 at 35e7f39: must-fix. Four items.
1. A skills list that throws (over the 200 file or 5 MB cap) made the platform retry the run for ever.
2. The 5 MiB image cap was on raw bytes, but base64 adds a third and Anthropic refuses images over 5 MB.
3. A Durable Object SQLite row holds 2 MB, and pi-durable stores a message with its images in one row.
4. `read_input_file` read as the newest run, so a file attached in an earlier run of the session was refused.

Fixes at fb4452e. A skills load that fails is logged and the run goes on. Images share a 1.2 MB budget per message, and the rest are listed but not shown. `read_input_file` reads as the run that has the file, and the skill tools use the run that loaded the skills (the `newest-run` key is gone). At most 100 output files go out.

Round 2 at fb4452e: clean.

## What was built

The agent's skills load at the first start of each run: a catalog prompt section, `activate_skill` (returns SKILL.md and lists the other files) and `read_skill_resource`. Frontmatter is read with `readSkillMeta` from services. Input files: images go to the model as image blocks, every file is listed in the message, and `read_input_file` returns text files. Output files: `[ATTACHMENT:/library/path]` in the final answer is read from the library and uploaded as the run, and the ids go to `completeRun` as `fileIds`, with the markers taken out of the text. The uploaded ids are stored on the run, so a completion that is tried again does not upload twice. `extractAttachmentMarkers` moved from the daemon to `@repo/protocol`. The services are called in process with a run principal, so no HTTP route or base URL is needed. The agent form text for cloud agents now says what works.

Live check, local dev with Haiku 5.5 as a cloud agent: a seeded skill gave its codeword, an attached PNG was seen (green), an attached text file was read through `read_input_file`, and `notes.txt` written with library `bash` came back as a file chip.

## Nits left

- A later run whose skills load fails keeps the earlier run's stored skills. The comment says "without them".
- `inputOf` writes the `input-file:<id>` keys as a side effect, on every start and wake. The keys are never deleted, and a wake can point an id at an older run (both are allowed to read it).
- No test covers `#readInput` in `pi-run.ts`. The DO class has no bun test.
- The image budget margin to 2 MB is thin if input text is full of control characters.
- A refused image or a file over the 100 cap gets no reason in the model's list or note.
- Inputs are downloaded whole (up to 50 MB each) to list non-images, and `read_input_file` and `sendMarker` read whole files before size checks. Two large files can pass the Durable Object's 128 MB of memory. `files.download` already has the metadata, and `library.stat` could check size first.
- A resumed run downloads and encodes its input files again on each wake, even when Pi already has the submission.
- Output mime types come from the file extension only. Uploads of library copies are stamped source `run`, not `library`.
- `activate_skill` and `read_skill_resource` have no size cap beyond the 5 MB total.

## Ideas beyond the scope

- Shrink large images with pi-durable's `createCloudflarePhotonImages` (exported, with `DEFAULT_IMAGE_LIMITS` and `toBase64`) so a normal photo is shown. At 1.2 MB total, a single phone photo is only listed.
- Cloud agents ignore `agent.instructions`. `PiRun` never passes them to Pi (the `instructions` field of the Pi agent state would take them). Not part of C.7, but a cloud agent runs without its own instructions today.
- The in-process run principal skips what `verifyRunToken` checks over HTTP (run is running, lease, token age). It gains no rights, but tools keep working for a finished run and `withOutputs` can upload for a cancelled one.
- Skills are fixed to the session's tool set at creation if Pi does not re-read extensions for an existing conversation. C.5's work on tool changes may cover this.

## Steps for Dom

- None needed for staging beyond the usual deploy. Local dev needs `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local`, because `wrangler.jsonc` sets the production URL and a local cloud run calls it back with its run token (`MCP initialize failed: 406` otherwise).
- For the staging check: add the workspace Anthropic key (Settings, Managed Agents), make a cloud agent, add a skill on its Skills tab, then chat with an image and a text file attached.
