type ImageFetch = NonNullable<
  import("@repo/services/live-artifacts/service").LiveArtifactsDeps["externalImageFetch"]
>;

/** A separate Worker keeps the app/agent runtime's routing unchanged. The
 * strictly-public flag closes the same-zone origin bypass; global fetch uses
 * the runtime's public network address filter at connect time, not a DNS
 * preflight. No parent bindings, credentials or privileged outbound are passed.
 * See docs/reviews/tasks/L.GAPS.md for the platform contract and local proof. */
export const IMAGE_EGRESS_CODE: WorkerLoaderWorkerCode = {
  compatibilityDate: "2026-08-19",
  compatibilityFlags: ["global_fetch_strictly_public"],
  env: {},
  limits: { cpuMs: 50, subRequests: 1 },
  mainModule: "image-egress.js",
  modules: {
    "image-egress.js": `export default {
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.protocol !== "https:" || url.username || url.password || url.port) {
          return new Response("Public HTTPS image GET required", {status: 400});
        }
        const remaining = Number(request.headers.get("x-hm-image-deadline")) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 10000) {
          return new Response("Image deadline exceeded", {status: 408});
        }
        return fetch(url.href, {
          method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
          headers: {Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif"},
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.ceil(remaining))]),
        });
      }
    };`,
  },
};

export const publicImageFetch =
  (loader: WorkerLoader): ImageFetch =>
  (input, init) =>
    loader
      .get("public-image-egress:v1", () => IMAGE_EGRESS_CODE)
      .getEntrypoint()
      .fetch(input, {
        headers: { "x-hm-image-deadline": String(init.deadline) },
        method: "GET",
        redirect: "manual",
        signal: init.signal,
      });
