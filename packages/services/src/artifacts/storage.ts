/**
 * App storage for the artifacts bridge (phase 2, task B.5). A signed-in member
 * reads and writes an artifact's per-viewer or shared storage. The Durable
 * Object store sits behind `AppStorePort`, a structural type so this package
 * imports nothing from the app.
 */

import type { Database } from "@repo/db";
import { findArtifactAccess } from "@repo/db/artifact-calls";
import type { StorageGetResult } from "@repo/protocol/artifacts";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { canOpen } from "./policy.ts";

export type StorageArea = "shared" | "viewer";

export interface AppStoreScope {
  area: StorageArea;
  artifactId: string;
  /** `u:<userId>`. Ignored in the shared area. */
  viewerKey: string;
}

export interface StoredItem {
  key: string;
  value: string;
}

export interface AppStorePort {
  delete: (scope: AppStoreScope, key: string) => Promise<void>;
  get: (scope: AppStoreScope, key: string) => Promise<string | null>;
  list: (
    scope: AppStoreScope,
    prefix: string,
    limit: number
  ) => Promise<StoredItem[]>;
  /** Throws an `Error` whose message starts `quota_exceeded` or `too_large`. */
  set: (scope: AppStoreScope, key: string, value: string) => Promise<void>;
}

export interface ArtifactStorageDeps {
  db: Database;
  store: AppStorePort;
}

interface Target {
  artifactId: string;
  scope: StorageArea;
}

export const MAX_KEY_BYTES = 256;
export const MAX_VALUE_BYTES = 1_048_576;
export const LIST_LIMIT = 1000;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

const parseJson = (text: string): StorageGetResult | null => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
};

const mapStoreError = (error: unknown): never => {
  if (error instanceof Error) {
    if (error.message.startsWith("quota_exceeded")) {
      throw new ServiceError("invalid", "App storage is full.");
    }
    if (error.message.startsWith("too_large")) {
      throw new ServiceError("invalid", "That value is too large.");
    }
  }
  throw error;
};

export const createArtifactStorageService = ({
  db,
  store,
}: ArtifactStorageDeps) => {
  /** Refuses non-users and artifacts the member may not open, as not_found. */
  const scopeFor = async (
    principal: Principal,
    action: string,
    target: Target
  ): Promise<AppStoreScope> => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(action);
    }
    authorize(principal, action, {
      id: target.artifactId,
      kind: "artifact",
      workspaceId: principal.workspaceId,
    });
    const artifact = await findArtifactAccess(db, {
      artifactId: target.artifactId,
      workspaceId: principal.workspaceId,
    });
    if (
      artifact === null ||
      !canOpen(artifact, {
        isAdmin: principal.isAdmin === true,
        userId: principal.userId,
      })
    ) {
      throw new ServiceError("not_found", "Artifact not found.");
    }
    return {
      area: target.scope,
      artifactId: target.artifactId,
      viewerKey: `u:${principal.userId}`,
    };
  };

  return {
    async delete(
      principal: Principal,
      input: Target & { key: string }
    ): Promise<Record<string, never>> {
      const scope = await scopeFor(principal, "artifact.storage.delete", input);
      await store.delete(scope, input.key);
      return {};
    },

    async get(
      principal: Principal,
      input: Target & { key: string }
    ): Promise<StorageGetResult> {
      const scope = await scopeFor(principal, "artifact.storage.get", input);
      const text = await store.get(scope, input.key);
      if (text === null) {
        return { value: null };
      }
      // An app's server code may write plain text, which comes back raw.
      const parsed = parseJson(text);
      return { value: parsed === null ? text : parsed.value };
    },

    async list(
      principal: Principal,
      input: Target & { prefix?: string }
    ): Promise<{ keys: string[] }> {
      const scope = await scopeFor(principal, "artifact.storage.list", input);
      const items = await store.list(scope, input.prefix ?? "", LIST_LIMIT);
      return { keys: items.map((item) => item.key) };
    },

    async set(
      principal: Principal,
      input: Target & { key: string; value: unknown }
    ): Promise<Record<string, never>> {
      const scope = await scopeFor(principal, "artifact.storage.set", input);
      if (byteLength(input.key) > MAX_KEY_BYTES) {
        throw new ServiceError("invalid", "That key is too long.");
      }
      const text = JSON.stringify(input.value);
      if (text === undefined || byteLength(text) > MAX_VALUE_BYTES) {
        throw new ServiceError("invalid", "That value is too large.");
      }
      try {
        await store.set(scope, input.key, text);
      } catch (error) {
        mapStoreError(error);
      }
      return {};
    },
  };
};

export type ArtifactStorageService = ReturnType<
  typeof createArtifactStorageService
>;
