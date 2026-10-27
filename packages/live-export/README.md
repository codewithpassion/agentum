# Live export format engines

Reusable format engines only. No routes, authentication, downloads, browser binding, persistence or UI.

```ts
import {
  documentDOCX, documentPrintHTML, deckPPTX, deckPrintHTML,
  type OwnAssets,
} from "@repo/live-export";

// Construct this in an already authorized artifact/caller scope. Never populate
// it from a request's URLs or let read() fall back to an arbitrary URL fetch.
const assets: OwnAssets = {
  paths: authorizedArtifactAssetPaths,
  read: path => authorizedArtifactStore.readPNG(path),
};
const { value: bytes, warnings } = await documentDOCX(completeYjsCheckpoint, assets);
const { value: html } = await deckPrintHTML(completeDeckCheckpoint, assets);
```

All four asynchronous functions return `{ value, warnings: { code, path, detail }[] }`. Office values are `Uint8Array`; print values are self-contained HTML strings. `deckPPTX` and `deckPrintHTML` accept optional `{ width, height }` in CSS pixels, default 1280 × 720; each dimension must be finite and between 96 and 4096. PDF integration should print with background graphics, prefer CSS page size and disable browser headers/footers. Functions throw on invalid snapshots, assets or limits. Export-specific refusals are `ExportError` with `code` and optional `path`; shared authority validation errors remain their original errors. Never substitute a success response on error. Empty decks are refused.

Input must be a complete Yjs checkpoint from the authorized artifact, not ProseMirror JSON, agent HTML, a partial update or a user-asserted scene. Each call admits the bytes into a fresh `LiveDocument` or `Deck` using the production shared rich-text codec, then reads its detached projection. Source rooms/checkpoints are never edited. Schema authority stays in live-doc/live-deck. The caller owns artifact-type selection, authorization, serialized checkpoint capture, snapshot version/attribution, deadlines, cancellation and permission revocation. `OwnAssets` is mandatory even for text-only exports. Its path inventory is copied before asynchronous reads; its `read` must recheck current authorization and return verified own-asset bytes. Only canonical `/files/...` paths in that inventory can reach it.

Image support is intentionally closed: inert 8-bit, noninterlaced grayscale/RGB/gray-alpha/RGBA PNG with IHDR, IDAT and IEND chunks. Other MIME types, indexed/interlaced PNG, ancillary chunks and active formats fail explicitly; upstream authorized asset processing must normalize them to this PNG subset. The engine checks signature/MIME, dimensions, chunks, CRC-32, decompression size/filter bytes and Adler-32. It never fetches asset URLs, emits remote image relationships or accepts raw HTML/CSS. Limits: 16 MB checkpoint; 5 MB/image; 4 million pixels/image and 8192 pixels/dimension; 20 MB unique and repeated image bytes; 4096 PNG chunks; 20,000 projected values and 4 million string code units; 32 MB final output. XML 1.0-illegal text is refused. These are application ceilings, not a guarantee that every ceiling combination fits a Worker CPU/memory budget.

DOCX preserves headings, paragraphs, nested numbered/bullet lists, task checkbox labels, merged table cells and shared cell colors, marks, chip labels and raster images; code uses monospace and quotes are indented. Lists start independently; Word supports nine numbered nesting levels. Chips become readable labels. Links become text with warnings; pending blocks become warned placeholders. Table column width hints use automatic Word layout with warnings. Print HTML uses semantic blocks, merged cells, marks, checkbox labels and data images; A4 pagination has controlled margins, widow/orphan rules and row/image break avoidance.

PPTX uses MIT PptxGenJS with explicit inches = CSS pixels / 96 and points = pixels × 0.75. Pinned boxes, painter order, local unrotated group offsets, theme font choices, colors, rotated text/images/shapes, tables and speaker notes are mapped. Static deck HTML uses exactly one CSS-sized print page per slide, pinned geometry and generated inert vector shapes. Both report unsupported flow elements/subtrees, icons/connectors, group rotation/inherited styles and transitions/builds. PPTX warns about paragraph/list/link presentation, font wrapping, alpha/opacity, line height, alignment and border radius approximations. Print omits speaker notes with a warning. PPTX does not implement animations or automatic browser flex/grid layout. No product parity or release acceptance is claimed.

The supported runtime path is a browser-target bundle executed in workerd, tested with Miniflare at compatibility date 2026-08-19. PptxGenJS's Node file/network APIs and docx file/stream APIs are not exposed or called. Bundled libraries contain unused polyfills and lazy Node filesystem imports; do not copy their unrestricted APIs into a Worker route. The automated test actually runs both archive generators in workerd, without a DOM and with global fetch trapped, then parses their ZIP/XML and resolves relationships. Chrome tests print representative multi-page documents and two-slide decks with no network requests (`CHROME_BIN` may override `/usr/bin/google-chrome`). Tests do not invoke Cloudflare Browser Run, remote Office software or a production endpoint.
