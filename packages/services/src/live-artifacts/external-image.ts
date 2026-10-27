/** Public HTTPS URL validation is defense in depth. The injected transport
 * MUST enforce public network addresses at connection time (including DNS
 * results and every redirect). Production uses an isolated strictly-public
 * Cloudflare Worker; a DNS lookup followed by ordinary fetch is insufficient. */
import { checkUrl } from "../connectors/safe-url.ts";
import { ServiceError } from "../errors.ts";
import { imageMime } from "./image-mime.ts";

export type ImageFetch = (
  input: string,
  init: RequestInit & { deadline: number }
) => Promise<Response>;

const MAX_BYTES = 8 * 1024 * 1024;
const refused = () =>
  new ServiceError(
    "invalid",
    "Use a public HTTPS PNG, JPEG, GIF, WebP or AVIF image (maximum 8 MiB)"
  );
const target = (value: string) => {
  const checked = checkUrl(value);
  if (!checked.ok) {
    throw refused();
  }
  const { url } = checked;
  if (value.length > 2048 || url.port || url.hash) {
    throw refused();
  }
  return url;
};
export async function fetchExternalImage(
  value: string,
  fetcher: ImageFetch,
  limits?: { deadline: number; signal: AbortSignal; maxBytes: number }
): Promise<Blob> {
  let url = target(value);
  const deadline = Math.min(
    Date.now() + 10_000,
    limits ? limits.deadline : Date.now() + 10_000
  );
  const signal = limits
    ? AbortSignal.any([
        limits.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ])
    : AbortSignal.timeout(10_000);
  const maxBytes = Math.min(MAX_BYTES, limits ? limits.maxBytes : MAX_BYTES);
  signal.throwIfAborted();
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: redirects must be validated before the next request.
    const response = await fetcher(url.href, {
      cache: "no-store",
      credentials: "omit",
      deadline,
      headers: {
        Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
      },
      method: "GET",
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("Location");
      if (!location || redirects === 3) {
        throw refused();
      }
      url = target(new URL(location, url).href);
      continue;
    }
    const type = response.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      !(
        response.ok &&
        response.body &&
        [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/avif",
        ].includes(type ?? "")
      ) ||
      Number(response.headers.get("Content-Length")) > maxBytes
    ) {
      await response.body?.cancel();
      throw refused();
    }
    return readImage(response.body, type, signal, maxBytes);
  }
  throw refused();
}

const readImage = async (
  stream: ReadableStream<Uint8Array>,
  type: string | undefined,
  signal: AbortSignal,
  maxBytes: number
): Promise<Blob> => {
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: bounded streaming read.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        throw refused();
      }
      chunks.push(new Uint8Array(chunk.value));
    }
    const body = new Blob(chunks, { type });
    if (size < 12 || (await imageMime(body)) !== type) {
      throw refused();
    }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel();
  }
};
