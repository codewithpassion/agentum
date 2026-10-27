import type { Database } from "@repo/db";
import {
  deckPPTX,
  deckPrintHTML,
  documentDOCX,
  documentPrintHTML,
  ExportError,
  limits,
  type OwnAssets,
} from "@repo/live-export";
import { parseEmbedSource } from "@repo/protocol/deck";
import { ForbiddenError } from "../authz.ts";
import type { FilesService } from "../files.ts";
import { createLiveAccess } from "../live-artifacts/access.ts";
import type {
  LiveArtifactsService,
  LiveRoomsPort,
} from "../live-artifacts/service.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";

export type ExportFormat = "docx" | "pptx" | "pdf";
export type PrintPDF = (
  html: string,
  signal: AbortSignal
) => Promise<Uint8Array>;
export const exportLimits = {
  html: 24_000_000,
  output: 32_000_000,
  timeout: 45_000,
  warnings: 24_000,
} as const;
export const exportMIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
const unsafeFilename = /[^a-zA-Z0-9 _-]/g;
const ownPath = /^\/files\/([A-Za-z0-9_-]+)$/;
const failed = (code: string) => new ExportError(code);

async function readAsset(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: Bound each streamed chunk before accepting the next.
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      length += chunk.value.length;
      if (length > limits.asset) {
        throw failed("export_asset_limit");
      }
      if (chunks.length >= 4096) {
        throw failed("export_asset_limit");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A request-scoped service; no public URL retrieval, mutation, or client checkpoint input. */
export function createLiveExportsService(deps: {
  db: Database;
  clock: Clock;
  live: Pick<LiveArtifactsService, "ownBlobUrls">;
  rooms?: Pick<LiveRoomsPort, "snapshot">;
  files: Pick<FilesService, "download" | "describe">;
  printPDF?: PrintPDF;
  /** Tests may shorten the deadline; production cannot extend the ceiling. */
  timeoutMs?: number;
  /** Keep late browser acquisition/close alive after a deadline response. */
  defer?: (work: Promise<void>) => void;
}) {
  const { access } = createLiveAccess(deps);
  return {
    async download(
      principal: Principal,
      input: { artifactId: string; format: ExportFormat },
      revalidate: () => Promise<void> = async () => undefined,
      cancellation?: AbortSignal
    ) {
      // Guests are not Principals. Runs/system are deliberately excluded from member downloads.
      if (principal.kind !== "user") {
        throw new ForbiddenError("liveExports.member");
      }
      const controller = new AbortController();
      const { signal } = controller;
      const cancel = () => controller.abort(failed("export_cancelled"));
      cancellation?.addEventListener("abort", cancel, { once: true });
      if (cancellation?.aborted) {
        cancel();
      }
      const timer = setTimeout(
        () => controller.abort(failed("export_timeout")),
        Math.max(
          1,
          Math.min(exportLimits.timeout, deps.timeoutMs ?? exportLimits.timeout)
        )
      );
      const check = async () => {
        signal.throwIfAborted();
        await revalidate();
        const authorized = await access(principal, input.artifactId);
        signal.throwIfAborted();
        return authorized;
      };
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Sequential admission, asset and delivery gates share one cancellation scope.
      const work = async () => {
        const { row } = await check();
        if (!deps.rooms?.snapshot) {
          throw failed("export_unavailable");
        }
        if (
          (row.kind === "deck" && input.format === "docx") ||
          (row.kind === "document" && input.format === "pptx")
        ) {
          throw failed("export_format");
        }
        const inventory = async () => {
          await check();
          const { urls } = await deps.live.ownBlobUrls(principal, {
            artifactId: row.id,
          });
          if (
            !Array.isArray(urls) ||
            urls.length > 4096 ||
            urls.some(
              (url) =>
                typeof url !== "string" ||
                !(ownPath.test(url) || parseEmbedSource(url))
            )
          ) {
            throw failed("export_asset_inventory");
          }
          return new Set(urls);
        };
        const loadedPaths = new Set<string>();
        const assets: OwnAssets = {
          paths: await inventory(),
          read: async (path) => {
            const match = ownPath.exec(path);
            if (!(match && (await inventory()).has(path))) {
              throw failed("export_asset_scope");
            }
            const [, id] = match;
            if (!id) {
              throw failed("export_asset_scope");
            }
            const [record] = await deps.files.describe(principal, [id]);
            if (!record || record.size > limits.asset) {
              throw failed("export_asset_limit");
            }
            const { body, file } = await deps.files.download(principal, id);
            const bytes = await readAsset(body, signal);
            if (!(await inventory()).has(path)) {
              throw failed("export_asset_scope");
            }
            loadedPaths.add(path);
            return { bytes, mime: file.mime };
          },
        };
        // The room serializes capture with accepted edits. Export never sends a client update.
        const snapshot = await deps.rooms.snapshot({
          artifactId: row.id,
          workspaceId: row.workspaceId,
        });
        await check();
        const printEngine =
          row.kind === "deck" ? deckPrintHTML : documentPrintHTML;
        const officeEngine = input.format === "pptx" ? deckPPTX : documentDOCX;
        const engine = input.format === "pdf" ? printEngine : officeEngine;
        const result = await engine(snapshot.state, assets);
        await check();
        let bytes: Uint8Array;
        if (typeof result.value === "string") {
          if (
            new TextEncoder().encode(result.value).length > exportLimits.html
          ) {
            throw failed("export_html_limit");
          }
          if (!deps.printPDF) {
            throw failed("export_unavailable");
          }
          bytes = await deps.printPDF(result.value, signal);
          if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
            throw failed("export_pdf_invalid");
          }
        } else {
          bytes = result.value;
        }
        if (!bytes.length || bytes.length > exportLimits.output) {
          throw failed("export_output_limit");
        }
        const warnings = encodeURIComponent(JSON.stringify(result.warnings));
        if (warnings.length > exportLimits.warnings) {
          throw failed("export_warning_limit");
        }
        const currentPaths = await inventory();
        if ([...loadedPaths].some((path) => !currentPaths.has(path))) {
          throw failed("export_asset_scope");
        }
        await check();
        const stem =
          row.title.replace(unsafeFilename, "_").trim().slice(0, 100) ||
          "artifact";
        return {
          bytes,
          filename: `${stem}.${input.format}`,
          mime: exportMIME[input.format],
          revision: snapshot.revision,
          warnings,
        };
      };
      try {
        const pending = work();
        deps.defer?.(
          pending.then(
            () => undefined,
            () => undefined
          )
        );
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            })
          ),
        ]);
      } finally {
        cancellation?.removeEventListener("abort", cancel);
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
export type LiveExportsService = ReturnType<typeof createLiveExportsService>;
