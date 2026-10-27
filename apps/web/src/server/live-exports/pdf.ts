import type { PrintPDF } from "@repo/services/live-exports";

/** Structural subset shared by local Chrome fixtures and the production Browser Run adapter. */
export interface PrintSession {
  close: () => Promise<void>;
  page: {
    route: (
      pattern: string,
      handler: (route: { abort: () => Promise<void> }) => Promise<void>
    ) => Promise<unknown>;
    setContent: (
      html: string,
      options: { timeout: number; waitUntil: "load" }
    ) => Promise<unknown>;
    emulateMedia: (options: { media: "print" }) => Promise<void>;
    pdf: (options: {
      preferCSSPageSize: true;
      printBackground: true;
      displayHeaderFooter: false;
      timeout: number;
    }) => Promise<Uint8Array>;
  };
}
export function printPDF(open: () => Promise<PrintSession>): PrintPDF {
  return async (html, signal) => {
    signal.throwIfAborted();
    const session = await open();
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= session.close();
      return closing;
    };
    const cancel = () => {
      close().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      // No navigation, credentials, public URLs, filesystem, JS or network resource loading.
      await session.page.route("**/*", (route) => route.abort());
      await session.page.setContent(html, {
        timeout: 15_000,
        waitUntil: "load",
      });
      signal.throwIfAborted();
      await session.page.emulateMedia({ media: "print" });
      const bytes = await session.page.pdf({
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        printBackground: true,
        timeout: 20_000,
      });
      signal.throwIfAborted();
      return bytes;
    } finally {
      signal.removeEventListener("abort", cancel);
      await close();
    }
  };
}
