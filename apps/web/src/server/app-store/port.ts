// The port over the AppStore namespace, one Durable Object per artifact. B.2's
// AppHost and B.5's storage procedures take an `AppStorePort`, built here from
// `env.APP_STORE` (B.8 adds the binding).
import type { AppStore } from "./app-store.ts";
import { canWrite, viewerKey } from "./rules.ts";
import type {
  AppStorePort,
  AppStoreScope,
  AppViewer,
  StorageArea,
  StoredItem,
} from "./types.ts";

export const appStorePort = (
  namespace: DurableObjectNamespace<AppStore>
): AppStorePort => {
  const store = (artifactId: string) =>
    namespace.get(namespace.idFromName(artifactId));
  return {
    delete: async (scope, key) =>
      store(scope.artifactId).deleteItem(scope.area, scope.viewerKey, key),
    get: async (scope, key) =>
      store(scope.artifactId).getItem(scope.area, scope.viewerKey, key),
    list: async (scope, prefix, limit) =>
      store(scope.artifactId).listItems(
        scope.area,
        scope.viewerKey,
        prefix,
        limit
      ),
    set: async (scope, key, value) =>
      store(scope.artifactId).setItem(scope.area, scope.viewerKey, key, value),
    usage: async (artifactId) => store(artifactId).usage(),
    wipe: async (artifactId) => store(artifactId).wipe(),
  };
};

const DEFAULT_LIST_LIMIT = 100;

/**
 * One viewer's storage calls, shaped like the `HM` storage methods. It scopes
 * each call to the viewer and refuses a write that `canWrite` denies with
 * `forbidden`, so AppHost and B.5 apply the same rule.
 */
export const viewerStorage = (
  port: AppStorePort,
  artifactId: string,
  viewer: AppViewer
) => {
  const scopeOf = (area: StorageArea): AppStoreScope => ({
    area,
    artifactId,
    viewerKey: viewerKey(viewer),
  });
  const requireWrite = (area: StorageArea): void => {
    if (!canWrite(viewer, area)) {
      throw new Error(`forbidden: this viewer cannot write the ${area} area`);
    }
  };
  return {
    deleteItem: async (area: StorageArea, key: string): Promise<void> => {
      requireWrite(area);
      await port.delete(scopeOf(area), key);
    },
    getItem: (area: StorageArea, key: string): Promise<string | null> =>
      port.get(scopeOf(area), key),
    listItems: (
      area: StorageArea,
      prefix = "",
      limit = DEFAULT_LIST_LIMIT
    ): Promise<StoredItem[]> => port.list(scopeOf(area), prefix, limit),
    setItem: async (
      area: StorageArea,
      key: string,
      value: string
    ): Promise<void> => {
      requireWrite(area);
      await port.set(scopeOf(area), key, value);
    },
  };
};
