import { z } from "zod";

const disposition = /filename="([a-zA-Z0-9 _.-]+)"/;
export type DownloadFormat = "docx" | "pptx" | "pdf";
const warningSchema = z.array(
  z.object({ code: z.string(), detail: z.string(), path: z.string() })
);
export async function prepareDownload(
  artifactId: string,
  format: DownloadFormat,
  signal: AbortSignal
) {
  const response = await fetch(
    `/api/live-artifacts/${encodeURIComponent(artifactId)}/export/${format}`,
    {
      credentials: "same-origin",
      method: "POST",
      signal,
    }
  );
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      z.object({ error: z.string() }).safeParse(result).data?.error ??
        `Export failed (${response.status})`
    );
  }
  const warnings = warningSchema.parse(
    JSON.parse(
      decodeURIComponent(response.headers.get("X-Export-Warnings") ?? "[]")
    )
  );
  const filename = response.headers
    .get("Content-Disposition")
    ?.match(disposition)?.[1];
  const revision = response.headers.get("X-Export-Revision");
  if (!(filename && revision)) {
    throw new Error("Invalid export response");
  }
  return { blob: await response.blob(), filename, revision, warnings };
}
export function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to consume the click before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
