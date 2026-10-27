/** Deliberately finite public image origins, not a general URL proxy. These
 * operator-controlled hosts cannot be supplied by a caller or resolve via a
 * caller-controlled DNS name. Every redirect is checked against the same list. */
import { ServiceError } from "../errors.ts";
import { imageMime } from "./image-mime.ts";

export type ImageFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

const HOSTS = new Set([
  "images.unsplash.com",
  "upload.wikimedia.org",
  "images.pexels.com",
]);
const MAX_BYTES = 8 * 1024 * 1024;
const refused = () =>
  new ServiceError(
    "invalid",
    "Use an HTTPS image from images.unsplash.com, upload.wikimedia.org or images.pexels.com (maximum 8 MiB)"
  );
const target = (value: string) => {
  if (!URL.canParse(value)) {
    throw refused();
  }
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !HOSTS.has(url.hostname)
  ) {
    throw refused();
  }
  return url;
};
export async function fetchExternalImage(
  value: string,
  fetcher: ImageFetch
): Promise<Blob> {
  let url = target(value);
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: redirects must be validated before the next request.
    const response = await fetcher(url.href, {
      credentials: "omit",
      headers: {
        Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
      },
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
      Number(response.headers.get("Content-Length")) > MAX_BYTES
    ) {
      await response.body?.cancel();
      throw refused();
    }
    return readImage(response.body, type, signal);
  }
  throw refused();
}

const readImage = async (
  stream: ReadableStream<Uint8Array>,
  type: string | undefined,
  signal: AbortSignal
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
      if (size > MAX_BYTES) {
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
