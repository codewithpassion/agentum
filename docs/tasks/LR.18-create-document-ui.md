---
id: LR.18
title: Create document from the artifacts page, like Create deck
milestone: LR
size: S
status: done
depends_on: []
branch: task/LR.18-create-document-ui
lane: web
executor: claude
---

Dom, 29 Oct 2026: the production smoke test found a "Create deck" action on `/artifacts` but no way to create a document from the UI (the agent had to call `liveArtifacts.createDocument` over tRPC). If decks can be created, documents should be too.

## Scope
- Add "Create document" next to "Create deck", mirroring its placement, flow (title prompt or default title, then open the new artifact) and permissions, using the existing `liveArtifacts.createDocument` procedure. Use existing shadcn/app components.
- Check what the artifacts page offers for removing a deck. If decks have a delete/archive action and documents don't, give documents the same; if neither has one, don't add it (note it in the review file).

## Check
- Component or route test: Create document calls the procedure and navigates to the new document; members without create permission don't see it (same rule as Create deck).
- Browser check on local dev at 1280x800 and 390x844: create a document, land in the editor, type; the button is at least 40px tall at 390px.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-29: created; dispatched.
- 2026-10-29: merged at 40ef524e, review clean. No delete/archive exists for decks or documents.
