# LR.2 review: guarded document_edit ingests external Markdown images

## Verdicts
- Round 1 (92993cfb): must-fix. withStoredImages dropped already-owned images in the same Markdown, the edit-time quota ignored state/Markdown/HTML bytes, and nothing tested digest immutability.
- Round 2 (ef699471, fix commits only): clean.

## Design
The room fetches only after guard admission. `documentEdit` runs `translateBatch` first, then stages images through `roomStageEditImages` (file ids hash artifact, change id and URL, so retries reuse rows and never refetch). Ownership is published through the room's image queue, the translated ops are rewritten (never the input ops, which keep the digest), and a failed edit with no accepted change or suggestion discards its staged rows, bytes and ownership. Scoped guest runs are refused by `requireUnscoped`. No migration.

## Nits left
- The quota base (`baseBytes` = state + 2x Markdown) is an estimate. The checkpoint check still enforces the exact limit. Manifest orphans (rejected suggestions) count toward it.
- Publishing ownership happens before the room decides direct or suggestion, so a rejected suggestion keeps its images owned and unreferenced.
- Two in-flight calls with the same change id can both fetch, and one failing call's cleanup can delete the other's blob.
- Quota check and manifest read are not serialized with other manifest writers.
- Inline images mixed with text in one paragraph are dropped by the existing sanitizer even after fetching. Only block-level images survive.
- `isServiceError` maps all service errors to `validation`. The runner's collision check does not assert the message. `image-setup.test.ts` is a helper named as a test only to satisfy boundary lint.
- `roomDiscardEditImages` trusts the room-supplied run id and `edit-` prefix.

## Ideas beyond scope
- Reject cleanup for suggestions. A room-level test for the discard guard with workerd fault injection.

## Dom
None.
