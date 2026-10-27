/** Fakes of the gateway's ports, for tests only. */

import type { AppCallPort, AppGatewayPorts, ShareState } from "./ports.ts";
import type {
  AppStorePort,
  AppStoreScope,
  AppViewer,
  StorageArea,
} from "./types.ts";

export interface FakeStore extends AppStorePort {
  rows: Map<string, string>;
}

const rowKey = (scope: AppStoreScope, key: string): string =>
  `${scope.artifactId}|${scope.area}|${scope.area === "shared" ? "" : scope.viewerKey}|${key}`;

export const fakeStore = (): FakeStore => {
  const rows = new Map<string, string>();
  return {
    delete: (scope, key) => {
      rows.delete(rowKey(scope, key));
      return Promise.resolve();
    },
    get: (scope, key) => Promise.resolve(rows.get(rowKey(scope, key)) ?? null),
    list: (scope, prefix, limit) => {
      const start = rowKey(scope, prefix);
      const base = rowKey(scope, "");
      return Promise.resolve(
        [...rows.entries()]
          .filter(([k]) => k.startsWith(start))
          .map(([k, value]) => ({ key: k.slice(base.length), value }))
          .slice(0, limit)
      );
    },
    rows,
    set: (scope, key, value) => {
      rows.set(rowKey(scope, key), value);
      return Promise.resolve();
    },
  };
};

/** The rule from `docs/v3/phase2-spike.md`: members write both areas, a snapshot link none, a live link only its own area. */
export const spikeCanWrite = (
  viewer: AppViewer,
  area: StorageArea
): boolean => {
  if (viewer.kind === "member") {
    return true;
  }
  return viewer.dataMode === "live" && area === "viewer";
};

export interface FakePorts extends AppGatewayPorts {
  calls: AppCallPort & { seen: unknown[] };
  hosts: { list: string[]; reads: number };
  share: { state: ShareState };
  store: FakeStore;
}

export const fakePorts = (): FakePorts => {
  const share: { state: ShareState } = {
    state: { dataMode: "snapshot", ok: true },
  };
  const hosts = { list: [] as string[], reads: 0 };
  const seen: unknown[] = [];
  return {
    calls: {
      asLink: (call) => {
        seen.push({ via: "link", ...call });
        return Promise.resolve({ ok: true });
      },
      asMember: (call) => {
        seen.push({ via: "member", ...call });
        return Promise.resolve({ ok: true });
      },
      seen,
    },
    canWrite: spikeCanWrite,
    grants: {
      announce: () => Promise.resolve(),
      approvedHosts: () => {
        hosts.reads += 1;
        return Promise.resolve([...hosts.list]);
      },
      secretRules: () => Promise.resolve([]),
    },
    hosts,
    share,
    shares: { state: () => Promise.resolve(share.state) },
    source: {
      bundle: () => Promise.resolve(null),
    },
    store: fakeStore(),
  };
};
