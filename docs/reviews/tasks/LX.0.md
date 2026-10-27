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

Final command results and commit IDs appear at the end of this record.

## Controller integration gates

Authorization, current artifact type, own-blob inventory/retrieval, consistent checkpoint capture, permission revocation, job limits/deadlines, PDF Browser Run invocation, authenticated download endpoints/content headers, filenames, UI warning display/confirmation and release are separate controller work. Use print backgrounds, prefer CSS page size, and disable browser headers/footers when integrating PDF. The adapter must surface warnings and refusals; do not advertise pixel-identical Office output or universal media support. Validate production resource budgets and the final production bundler/compatibility date before exposing endpoints. No phase-wide or production-readiness claim is made by this leaf.

Final verification on 27 October 2026 (engine `247ee380`, hardening/runtime/print evidence `cec4e113`):

- Focused export suite: **11 pass, 0 fail, 558 assertions**. Includes actual workerd Office generation; XML well-formedness and every relationship target; rich content, independent numbering start, merged cells, images, theme font, group offsets, geometry and notes; deterministic output mappings and unchanged checkpoints; hostile snapshot marks/URLs and malformed bytes; MIME/PNG corruption, dimensions, inflate/filter bounds, repeated-image budget, serialized reads and queued-read abortion. Chrome prints a multi-page rich document and exactly two deck pages, verifies decoded images and vector shapes, with zero network requests.
- Root `bun run check`: **12/12 successful**, Ultracite clean, all package typechecks passed, boundary lint clean.
- Root `bun run test`: **12/12 successful**, zero failures; export package 11 pass, root scripts 284 pass. Existing web skip retained. This final run includes the last implementation change.
- Root `bun run build`: **5/5 successful**; the export browser bundle is approximately 3.11 MB uncompressed. Existing Vite CSS sourcemap warning is non-failing. The app does not import this isolated package yet.
- `bun install --frozen-lockfile`: passed with normal prepare scripts; 1,138 installs checked, no dependency changes. Existing environment files preserved.
- Emitted client `drizzle` scan: no matches; emitted export `cloudflare:workers`, `bun:sqlite`, `@repo/db` scan: no matches. Library browser polyfills and unused lazy Node filesystem paths remain as described above; no claim they are absent. `git diff --check`: clean.
- Two implementation commits plus this evidence-only update. No task-status edits or external publication actions were performed.

## Independent engine review — 27 October 2026

Reviewed merged engine tree at `0f75754d` against R4.2 and this record; the current checkout has no changes to `packages/live-export` relative to that commit. Scope is the isolated engines, not product acceptance.

### Findings

- **Medium — malformed PNG compressed streams can pass the advertised complete-stream validation.** `src/png.ts` feeds IDAT to `Unzlib` and checks the final four IDAT bytes against the computed Adler-32, but does not establish that the decoder consumed exactly one complete zlib stream. An independent probe took the valid fixture PNG, appended four junk bytes and a copy of the original Adler trailer after its complete zlib stream inside IDAT, and recomputed the PNG chunk CRC. `assetLoader` accepted the resulting 81-byte asset. Thus CRC, pixel count and the final checksum do not prove that IDAT is a valid single zlib stream; malformed bytes reach Office/Chrome decoders. This demonstrates a validation and format-correctness gap, not demonstrated script execution or network access. Require exact compressed-stream consumption and add a regression covering trailing data and concatenated streams.
- **Low — a multi-paragraph task item gains extra checkboxes in DOCX.** `src/document.ts` propagates `checkbox` to all child blocks and prepends the label to every paragraph. A valid authority-imported task item with two paragraphs produced two `☑` characters in `word/document.xml` and no warning, although it represents one task. Print HTML emits one checkbox for the item. Apply the label once per task item, including nested block cases.

### Boundary and evidence assessment

The mandatory port is bound before snapshot projection, copies the allowlist, gates canonical own paths, serializes reads and copies returned bytes. Reauthorization at retrieval remains the port implementer's contract; an inventory alone is not authorization. Shared authorities validate checkpoint projections and CSS value grammars; output text/attributes are escaped, no external relationship is intentionally created, and print CSP denies network sources. The PNG finding above qualifies the claimed complete validation. Supported PNG subset refusals and the documented flow, link, font, media and other omission warnings are deliberate limitations, not independent defects found here.

Resource ceilings are useful admission bounds, not peak-memory or CPU guarantees: projection is checked after authority decoding, output limits after construction/serialization, and image decoding/library generation have intermediate allocations. The report correctly leaves production quota, deadlines and concurrency to integration; test those with production bundling and worst-case accepted combinations. R4.2's authenticated routes, PDF Browser Run, downloads, warning UX and release remain outstanding controller gates; these isolated engines do not establish end-to-end delivery or Office application round-trip.

Focused verification in this checkout after `bun install --frozen-lockfile --ignore-scripts`: `bun run test` in `packages/live-export` **11 pass, 0 fail, 558 assertions**; `bun run typecheck` passed. The suite actually ran its Miniflare/workerd browser bundle and parsed archive XML/relationships, and local Chrome printed the document and two-slide PDF with request interception. These are fixture-specific runtime observations, not proof of production compatibility or visual fidelity for all inputs. The two independent probes above ran separately. Root suite was not repeated for this report-only review; no product or task files were changed.

## Controller remediation

Both independent findings are addressed. PNG admission now requires that the final DEFLATE byte is necessary for stream completion, using a bounded truncated-input probe after the existing CRC, decoded-size/filter and Adler checks. This rejects trailing junk with a copied checksum and concatenated zlib streams without relying on runtime-specific DecompressionStream behavior. The pinned decoder strips four trailer bytes; shortening its input by one byte therefore removes the final DEFLATE byte from its decoding window. Valid stored and Huffman-coded images remain accepted. DOCX task labels are consumed once per task item before asynchronous run conversion, with distinct state for nested tasks.

Focused suite: 14 tests, 567 assertions pass, including both malformed streams rejected inside actual workerd, valid archive generation and Chrome print checks, and a multi-paragraph/nested-task DOCX regression. Package typecheck and root check (12 tasks plus boundary lint) pass. Combined root test (12 workspace tasks plus 284 script tests) and build (5 tasks, 203 dev-only server files checked) passed. The existing CSS sourcemap warning remains non-failing; phase-wide export integration remains open.

### Independent bounded recheck of `db291d50` — 2026-10-27

The pinned `fflate` 0.8.2 `unzlibSync` strips four trailing bytes before inflating; calling it on the original zlib payload shortened by one byte therefore removes the final DEFLATE byte as well as the presumed four-byte trailer. The exact-end check rejects a stream that remains complete after that removal. The tests cover trailing bytes and concatenated streams, and retain stored and Huffman-coded valid images. The DOCX checkbox state is shared across continuation blocks and scoped anew for nested tasks. `bun test src/export.test.ts` in `packages/live-export` passed 13 tests, 557 assertions, including the real workerd archive test and checkbox regression. No further defect was identified in this bounded recheck; this does not replace browser or staging acceptance.

