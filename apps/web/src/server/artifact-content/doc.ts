// The markdown viewer for `doc` artifacts (R1.21b). The Worker renders the
// markdown (with GitHub tables, task lists and strikethrough) to HTML with
// react-markdown (raw HTML in the markdown is dropped
// and `javascript:` links are stripped by its defaults) and wraps it in a
// page with inline CSS only. The page is served from the content route, so it
// carries the same sandbox CSP as any artifact page.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

const DOC_CSS = `
:root{color-scheme:light dark}
body{margin:0;background:#fff;color:#1f2328;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.hm-doc{box-sizing:border-box;max-width:760px;margin:0 auto;padding:32px 20px 64px;overflow-wrap:anywhere}
.hm-doc h1,.hm-doc h2,.hm-doc h3,.hm-doc h4{line-height:1.25;margin:1.6em 0 .6em}
.hm-doc h1{font-size:2em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}
.hm-doc h2{font-size:1.5em;border-bottom:1px solid #d1d9e0;padding-bottom:.3em}
.hm-doc a{color:#0969da}
.hm-doc code{background:#eff1f3;border-radius:4px;padding:.15em .35em;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}
.hm-doc pre{background:#eff1f3;border-radius:6px;padding:14px 16px;overflow-x:auto}
.hm-doc pre code{background:none;padding:0}
.hm-doc blockquote{margin:1em 0;padding:0 1em;border-left:4px solid #d1d9e0;color:#59636e}
.hm-doc table{border-collapse:collapse;display:block;overflow-x:auto}
.hm-doc th,.hm-doc td{border:1px solid #d1d9e0;padding:6px 12px}
.hm-doc img{max-width:100%}
.hm-doc hr{border:0;border-top:1px solid #d1d9e0}
@media (prefers-color-scheme:dark){
body{background:#0d1117;color:#e6edf3}
.hm-doc h1,.hm-doc h2,.hm-doc hr,.hm-doc th,.hm-doc td,.hm-doc blockquote{border-color:#3d444d}
.hm-doc a{color:#4493f8}
.hm-doc code,.hm-doc pre{background:#151b23}
.hm-doc blockquote{color:#9198a1}
}`;

export interface DocPageOptions {
  /** `src` of the bridge script, relative to the page URL. */
  bridgeSrc: string;
  title?: string;
}

/** A complete HTML page showing `markdown`, with the bridge script first in `<head>`. */
export const renderDocPage = (
  markdown: string,
  options: DocPageOptions
): string => {
  const body = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown)
  );
  const title = escapeHtml(options.title ?? "Document");
  return `<!doctype html><html lang="en"><head><script src="${escapeHtml(options.bridgeSrc)}"></script><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${DOC_CSS}</style></head><body><main class="hm-doc">${body}</main></body></html>`;
};
