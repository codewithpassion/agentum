/** biome-ignore-all lint/performance/noAwaitInLoops: Image requests must serialize rotating host credentials. */
import {
  type GuestImageResult,
  type GuestPolicyResult,
  guestEndpoints,
} from "@repo/protocol/guest";
import type { LiveJoinResult } from "@repo/protocol/live";
import { guestHttp } from "./http";

export function guestServices(artifactId: string) {
  const images = new Map<string, string>();
  const endpoint = (action: Parameters<typeof guestEndpoints.artifact>[1]) =>
    guestEndpoints.artifact(artifactId, action);
  return {
    dispose() {
      for (const url of images.values()) {
        URL.revokeObjectURL(url);
      }
      images.clear();
    },
    endpoint,
    imageUrl: (path: string) => images.get(path),
    /** The queue is released on WebSocket open, after authenticated upgrade.
     * Policy synchronization itself needs the queue, so waiting for ready deadlocks. */
    join() {
      let admit: (() => void) | undefined;
      const admitted = new Promise<void>((resolve) => {
        admit = resolve;
      });
      let resolveJoin: (value: LiveJoinResult) => void;
      let rejectJoin: (reason: unknown) => void;
      const joined = new Promise<LiveJoinResult>((resolve, reject) => {
        resolveJoin = resolve;
        rejectJoin = reject;
      });
      guestHttp.run(async () => {
        try {
          const result = (await (
            await guestHttp.response(endpoint("join"), {
              body: "{}",
              headers: { "Content-Type": "application/json" },
              method: "POST",
            })
          ).json()) as LiveJoinResult;
          resolveJoin(result);
          await admitted;
        } catch (cause) {
          rejectJoin(cause);
        }
      });
      return { admitted: () => admit?.(), joined };
    },
    async policy() {
      const policy = await guestHttp.json<GuestPolicyResult>(
        endpoint("policy")
      );
      for (const path of policy.ownBlobUrls) {
        if (!images.has(path)) {
          const blob = await guestHttp.run(async () =>
            (
              await guestHttp.response(
                guestEndpoints.image(artifactId, path.slice("/files/".length))
              )
            ).blob()
          );
          images.set(path, URL.createObjectURL(blob));
        }
      }
      for (const [path, url] of images) {
        if (!policy.ownBlobUrls.includes(path)) {
          URL.revokeObjectURL(url);
          images.delete(path);
        }
      }
      return { ownBlobUrls: new Set(policy.ownBlobUrls) };
    },
    async upload(file: File) {
      const form = new FormData();
      form.append("file", file);
      const result = await guestHttp.run(
        async () =>
          (
            await guestHttp.response(endpoint("images"), {
              body: form,
              method: "POST",
            })
          ).json() as Promise<GuestImageResult>
      );
      const blob = await guestHttp.run(async () =>
        (
          await guestHttp.response(
            guestEndpoints.image(artifactId, result.url.slice("/files/".length))
          )
        ).blob()
      );
      const previous = images.get(result.url);
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      images.set(result.url, URL.createObjectURL(blob));
      return { alt: file.name, url: result.url };
    },
  };
}
export type GuestServices = ReturnType<typeof guestServices>;
