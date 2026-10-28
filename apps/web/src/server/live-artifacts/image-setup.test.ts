// biome-ignore-all lint/suspicious/useAwait: Captured in-memory ports implement production async interfaces.
import { artifacts, artifactVersions } from "@repo/db/schema/artifacts";
import { files } from "@repo/db/schema/files";
import {
  createLiveArtifactsService,
  type LiveArtifactsDeps,
} from "@repo/services/live-artifacts/service";
import { harness } from "../../../../../packages/services/src/artifacts/test-harness";
import { documentContent } from "./content";

export const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
]);
export const setup = () => {
  const h = harness();
  const requests: string[] = [];
  const deps: LiveArtifactsDeps = {
    ...h,
    anchors: {
      guardAgentSnapshot: async () => undefined,
      resolve: async (_scope, anchor) => ({ anchor, quote: null }),
    },
    artifacts: h.service,
    ask: {
      startComment: async () => {
        throw new Error("Outside import scope");
      },
    },
    changes: {
      revert: async () => {
        throw new Error("Outside import scope");
      },
    },
    clock: {
      now: () => new Date("2026-10-28T00:00:00Z"),
      sleep: async () => undefined,
    },
    content: documentContent(async (scope) => {
      const manifest = scope
        ? await h.blobs.get(
            `${scope.workspaceId}/live-artifacts/${scope.artifactId}/images.json`
          )
        : null;
      return new Set(
        manifest ? JSON.parse(new TextDecoder().decode(manifest.bytes)) : []
      );
    }),
    externalImageFetch: async (url) => {
      requests.push(url);
      if (url.endsWith("/denied")) {
        return new Response("denied", { status: 403 });
      }
      if (url.endsWith("/redirect")) {
        return Response.redirect("https://127.0.0.1/private", 302);
      }
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    },
    identity: async () => ({ color: "#123456", name: "Fixture" }),
    imageBlobs: {
      delete: async (key) => {
        await h.blobs.delete([key]);
      },
      put: async (key, body) => {
        await h.blobs.put(key, new Uint8Array(await body.arrayBuffer()));
      },
    },
    rooms: {
      refresh: async () => undefined,
      restore: async (_scope, input) => input.snapshot,
      url: () => "/room",
    },
    ticketKey: "fixture-key",
  };
  const service = createLiveArtifactsService(deps);
  const state = () => ({
    artifacts: h.db.select().from(artifacts).all().length,
    files: h.db.select().from(files).all().length,
    imageObjects: [...h.blobs.objects.keys()].filter(
      (key) => key.includes("/files/") || key.endsWith("/images.json")
    ).length,
    versions: h.db.select().from(artifactVersions).all().length,
  });
  return { ...h, deps, requests, service, state, staticArtifacts: h.service };
};
