// The SQL logic of the AppStore Durable Object, free of `cloudflare:workers`
// so bun can test it. One object holds the whole storage of one app: a `kv`
// table keyed by area, viewer and key, with a byte cap over all rows.
import { ARTIFACT_APP_STORAGE_MAX_BYTES } from "@repo/db/shared";
import type { StorageArea, StoredItem } from "./types.ts";

export const MAX_KEY_BYTES = 256;
export const MAX_VALUE_BYTES = 1024 * 1024;
export const MAX_LIST_LIMIT = 1000;

/** Runs one parameterized statement and returns its rows (empty for writes). */
export interface SqlAdapter {
  exec: (
    sql: string,
    ...params: (string | number)[]
  ) => Record<string, unknown>[];
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

export const createAppStoreCore = (
  sql: SqlAdapter,
  maxBytes: number = ARTIFACT_APP_STORAGE_MAX_BYTES
) => {
  /** The shared area has one viewer column value, the empty string. */
  const viewerOf = (area: StorageArea, viewerKey: string): string =>
    area === "shared" ? "" : viewerKey;

  const sumBytes = (rows: Record<string, unknown>[]): number =>
    Number(rows[0]?.total ?? 0);

  const usage = (): { bytes: number; maxBytes: number } => ({
    bytes: sumBytes(
      sql.exec("SELECT COALESCE(SUM(bytes), 0) AS total FROM kv")
    ),
    maxBytes,
  });

  return {
    delete: (area: StorageArea, viewerKey: string, key: string): void => {
      sql.exec(
        "DELETE FROM kv WHERE area = ?1 AND viewer = ?2 AND k = ?3",
        area,
        viewerOf(area, viewerKey),
        key
      );
    },
    // Separate from app-readable kv: app code cannot clear its own flood guard.
    // The next admitted event reports drops since the previous admitted event.
    errorSlot: (now: number): { dropped: number } | null => {
      const [row] = sql.exec("SELECT at, dropped FROM app_errors WHERE id = 1");
      if (row && now - Number(row.at) < 10_000) {
        sql.exec("UPDATE app_errors SET dropped = dropped + 1 WHERE id = 1");
        return null;
      }
      sql.exec(
        "INSERT INTO app_errors (id, at, dropped) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET at = excluded.at, dropped = 0",
        now
      );
      return { dropped: Number(row?.dropped ?? 0) };
    },

    get: (area: StorageArea, viewerKey: string, key: string): string | null => {
      const rows = sql.exec(
        "SELECT v FROM kv WHERE area = ?1 AND viewer = ?2 AND k = ?3",
        area,
        viewerOf(area, viewerKey),
        key
      );
      const value = rows[0]?.v;
      return typeof value === "string" ? value : null;
    },

    init: (): void => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS app_errors (id INTEGER PRIMARY KEY CHECK(id = 1), at INTEGER NOT NULL, dropped INTEGER NOT NULL)"
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS kv (area TEXT NOT NULL, viewer TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (area, viewer, k))"
      );
    },

    list: (
      area: StorageArea,
      viewerKey: string,
      prefix: string,
      limit: number
    ): StoredItem[] => {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
      const rows = sql.exec(
        "SELECT k, v FROM kv WHERE area = ?1 AND viewer = ?2 AND k >= ?3 AND substr(k, 1, ?4) = ?3 ORDER BY k LIMIT ?5",
        area,
        viewerOf(area, viewerKey),
        prefix,
        [...prefix].length,
        capped
      );
      return rows.map((row) => ({ key: String(row.k), value: String(row.v) }));
    },

    set: (
      area: StorageArea,
      viewerKey: string,
      key: string,
      value: string
    ): void => {
      const keyBytes = byteLength(key);
      if (keyBytes > MAX_KEY_BYTES) {
        throw new Error(
          `too_large: key is ${keyBytes} bytes, the limit is ${MAX_KEY_BYTES}`
        );
      }
      const valueBytes = byteLength(value);
      if (valueBytes > MAX_VALUE_BYTES) {
        throw new Error(
          `too_large: value is ${valueBytes} bytes, the limit is ${MAX_VALUE_BYTES}`
        );
      }
      const viewer = viewerOf(area, viewerKey);
      const rowBytes = keyBytes + valueBytes;
      const replaced = sumBytes(
        sql.exec(
          "SELECT COALESCE(SUM(bytes), 0) AS total FROM kv WHERE area = ?1 AND viewer = ?2 AND k = ?3",
          area,
          viewer,
          key
        )
      );
      const projected = usage().bytes - replaced + rowBytes;
      if (projected > maxBytes) {
        throw new Error(
          `quota_exceeded: storing this would use ${projected} bytes, the cap is ${maxBytes}`
        );
      }
      sql.exec(
        "INSERT INTO kv (area, viewer, k, v, bytes) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (area, viewer, k) DO UPDATE SET v = excluded.v, bytes = excluded.bytes",
        area,
        viewer,
        key,
        value,
        rowBytes
      );
    },

    usage,

    wipe: (): void => {
      sql.exec("DELETE FROM kv");
    },
  };
};
export type AppStoreCore = ReturnType<typeof createAppStoreCore>;
