# LX.0 — isolated export format engines

Implemented in `packages/live-export`, consuming the accepted live-doc schema/authority and live-deck core plus LD.2 production rich-text codec. Read `CLAUDE.md`, PRD R4.2 and §5, and L.2/LD.0/LD.2 review evidence. No app, server, route, service, UI, schema/core or migration changes. No `docs/tasks` edits, push, PR or deployment. Existing environment files preserved.

## API and authority boundary

Public exports: `documentDOCX(snapshot, ownAssets)`, `documentPrintHTML(snapshot, ownAssets)`, `deckPPTX(snapshot, ownAssets, page?)`, `deckPrintHTML(snapshot, ownAssets, page?)`; types `OwnAssets`, `DeckPage`, `Warning`, `Result<T>` and `ExportError`. Office returns `Promise<Result<Uint8Array>>`; print returns `Promise<Result<string>>`. Warnings have stable `code`, `path`, `detail`. Export refusals carry `ExportError.code` and optional path; admission failures preserve shared engine errors. Errors are not converted to a placeholder success.

Snapshots are complete binary Yjs checkpoints for an already authorized artifact. Documents go through fresh `LiveDocument.applyUpdate` and `json`; decks through fresh `Deck.applyUpdate`, production `richTextCodec`, `ids`, `read` and `theme`. Empty authorities and their Y.Docs are destroyed in finally blocks. No duplicate schema, HTML ingress, caller-asserted permissive scene or source mutation. Additional portable XML character and resource ceilings are export-format constraints. A snapshot's artifact type and completeness are the caller's authenticated checkpoint contract, not a claim the binary bytes can prove which artifact they came from.

The mandatory caller/artifact-bound asset port supplies a copied allowlist plus `read(path)`; the port must reauthorize at retrieval and never fall back to public URL fetching. Only canonical allowlisted own `/files` paths reach it. Reads are serialized and a failed asset prevents further queued reads. An export-local cache deduplicates reads, while both unique and repeated references have byte budgets. Inert PNG bytes are validated before either library or print renderer sees them: exact MIME/signature, IHDR bounds/encoding, checked complete chunk stream, CRC-32, bounded incremental inflate/filter checks, Adler-32 and terminal IEND. All other formats/encodings fail explicitly. No URL, HTML, script, external CSS, file path or external image is passed to PptxGenJS/docx. Static HTML has an explicit default-deny CSP and only embedded data PNGs, fixed generated CSS and generated vector geometry.

Limits: 16,000,000-byte checkpoint; 5,000,000-byte image; 20,000,000 unique/referenced image bytes; 4,000,000 pixels and 8192 pixels per dimension; 4096 PNG chunks; 20,000 recursively visited projection values and 4,000,000 total string code units; 32,000,000 final output bytes. Accepted shared schema/scene limits still apply first. Export limits can reject an otherwise valid artifact; they do not promise that every maximum-size combination fits a production Worker quota.

## Mapping and explicit limitations

- DOCX: headings, paragraphs, bold/italic/underline/strike/code/theme color, nested bullet/numbered lists with independent starts, task checkbox labels, chip labels, tables with row/column spans and cell colors, images, indented quotes, monospace code and horizontal rules. Pending blocks warn and show their intent. Links warn and become text. Width hints warn and use automatic Word layout; deeper numbering clamps at nine levels with a warning. No chip identity or live/comment semantics are exported.
- Document print: semantic escaped blocks, lists/marks/chip labels, merged/color cells, images and placeholders. A4 pages, margins, widow/orphan settings, heading break avoidance and row/image break avoidance. Browser font metrics determine actual document pagination.
- PPTX: MIT PptxGenJS, deterministic ordered scene traversal; CSS px / 96 → inches, px × 0.75 → points; pinned geometry and element rotation, unrotated local group offsets, theme fonts, colors, rich marked runs, fixed-size tables/images/shapes and speaker notes. No automatic table pagination into additional slides. Empty decks refuse export.
- Deck print: one fixed CSS page per slide, zero page margins and no trailing blank slide, pinned positions, rich text/table cells, data images and internally generated SVG shapes. Speaker notes are omitted with warnings.
- Both deck formats: flow elements and descendants, icons/connectors, group rotation and inherited group styles, transitions and builds have explicit omission/approximation warnings. PPTX warns about plain paragraph presentation for lists/links, font substitution/wrapping, opaque alpha/opacity approximation and ignored alignment/line-height/radius overrides. Fonts are referenced, not fetched or embedded. Print keeps safe CSS style values validated by the accepted scene; it does not execute scene strings as arbitrary CSS/HTML.
- Images: supported input is 8-bit noninterlaced grayscale/RGB/gray-alpha/RGBA PNG, containing only IHDR/IDAT/IEND. JPEG, indexed PNG, metadata/ancillary PNG chunks, interlacing, SVG and other media must be normalized by authorized upstream asset processing or produce a structured refusal. No asset normalization, remote ingestion or security scan service is invented here.

## Runtime evidence and primary references

Pinned `docx` 9.7.1 (MIT) and `pptxgenjs` 4.0.1 (MIT). `Packer.toArrayBuffer` and PptxGenJS `write({outputType: "uint8array", compression: true})` are in-memory entry points. PptxGenJS receives only embedded image `data`, never `path`.

Primary docs checked 27 October 2026:

- [docx Packer / toArrayBuffer](https://docx.js.org/api/classes/index.Packer.html).
- [PptxGenJS saving / output types](https://gitbrent.github.io/PptxGenJS/docs/usage-saving/) and [embedded images / coordinate units](https://gitbrent.github.io/PptxGenJS/docs/api-images/).
- [Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

Actual native workerd runs the browser-target bundle via Miniflare 5.20261012.0-beta, compatibility date `2026-08-19`, without a DOM. Global fetch is trapped so attempted library network access fails the test. Both format engines generate real archives inside workerd; the host unzips them, parses every XML part, verifies all internal relationship targets and checks text, marks, numbering, tables, images, geometry and notes. This is actual runtime execution, not a Bun-only compatibility assertion. Current Cloudflare docs enable Node compatibility by default at this compatibility date. No filesystem/network/stream methods are invoked; the bundle contains library polyfills and unused lazy `node:fs` paths, so this evidence covers only the exposed in-memory APIs and exact bundled configuration. Unbundled Node library entry points or other compatibility dates are not certified.

Local Chrome prints the fixture through Playwright: a multi-page rich document and exactly two CSS-sized slide pages; images decode, SVG ellipse fill/geometry is present, and all network requests are intercepted (none occur). The shared T3 preview failed with the host AppArmor sandbox error before any tab opened; local Chrome was the allowed fallback. This is static print fixture evidence, not Browser Run binding invocation, Office application round-trip or product acceptance.

## Validation

Final command results and commit IDs are appended after all changes below.

## Controller integration gates

Authorization, current artifact type, own-blob inventory/retrieval, consistent checkpoint capture, permission revocation, job limits/deadlines, PDF Browser Run invocation, authenticated download endpoints/content headers, filenames, UI warning display/confirmation and release are separate controller work. Use print backgrounds, prefer CSS page size, and disable browser headers/footers when integrating PDF. The adapter must surface warnings and refusals; do not advertise pixel-identical Office output or universal media support. Validate production resource budgets and the final production bundler/compatibility date before exposing endpoints. No phase-wide or production-readiness claim is made by this leaf.
