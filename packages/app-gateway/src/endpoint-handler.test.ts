import { expect, test } from "bun:test";
import { handleEndpointRoute } from "./endpoint-handler.ts";
import { fakePorts } from "./fakes.ts";
import type { AppRequestMeta } from "./types.ts";

test("the app runs before the visitor salt is read, and the access row still gets the hash", async () => {
  const order: string[] = [];
  const deferred: Promise<void>[] = [];
  const rows: AppRequestMeta[] = [];
  const hostMeta: AppRequestMeta[] = [];
  const endpoint = {
    artifactId: "a",
    endpointId: "e",
    name: "hook",
    versionId: "v",
    workspaceId: "w",
  };
  const response = await handleEndpointRoute(
    new Request("https://hooks.test/hooks/e", {
      headers: { "CF-Connecting-IP": "198.51.100.7", "User-Agent": "bot" },
    }),
    "e",
    {
      defer: (work) => deferred.push(work),
      wiring: () => ({
        declaresHosts: () => Promise.resolve(false),
        defer: (work) => deferred.push(work),
        endpoints: {
          recordCall: (_endpoint, meta) => {
            rows.push(meta);
            return Promise.resolve();
          },
          resolve: () => Promise.resolve(endpoint),
        },
        ports: fakePorts(),
        requestMeta: () => {
          order.push("salt");
          return Promise.resolve({
            ipPrefix: "198.51.100.0/24",
            place: null,
            userAgent: "bot",
            visitorHash: "hash",
          });
        },
        runtime: {
          handle: ({ host }) => {
            order.push("app");
            hostMeta.push(host.meta);
            return Promise.resolve(new Response("ok"));
          },
        },
      }),
    }
  );
  expect(await response.text()).toBe("ok");
  expect(hostMeta).toEqual([
    {
      ipPrefix: "198.51.100.0/24",
      place: null,
      userAgent: "bot",
      visitorHash: "",
    },
  ]);
  await Promise.all(deferred);
  expect(order).toEqual(["app", "salt"]);
  expect(rows).toEqual([
    {
      ipPrefix: "198.51.100.0/24",
      place: null,
      userAgent: "bot",
      visitorHash: "hash",
    },
  ]);
});
