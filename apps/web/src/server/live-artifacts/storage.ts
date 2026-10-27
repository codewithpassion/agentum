export const CHUNK_BYTES = 512 * 1024;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const COMPACT_UPDATES = 500;
export const COMPACT_BYTES = 1024 * 1024;

/** One SQL transaction writes all chunks and switches the generation pointer. */
export class RoomStorage {
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_chunks (kind TEXT, id TEXT, part INTEGER, data BLOB NOT NULL, PRIMARY KEY(kind,id,part))"
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_tickets (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)"
    );
  }
  get<T>(key: string): T | undefined {
    const [row] = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM room_meta WHERE key=?", key)
      .toArray();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO room_meta VALUES (?,?)",
      key,
      JSON.stringify(value)
    );
  }
  write(kind: string, id: string, bytes: Uint8Array) {
    this.storage.sql.exec(
      "DELETE FROM room_chunks WHERE kind=? AND id=?",
      kind,
      id
    );
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      this.storage.sql.exec(
        "INSERT INTO room_chunks VALUES (?,?,?,?)",
        kind,
        id,
        i / CHUNK_BYTES,
        bytes.slice(i, i + CHUNK_BYTES)
      );
    }
    this.put(`blob:${kind}:${id}`, bytes.length);
  }
  read(kind: string, id: string): Uint8Array {
    const size = this.get<number>(`blob:${kind}:${id}`);
    if (size === undefined) {
      throw new Error("Missing blob manifest");
    }
    const rows = this.storage.sql
      .exec<{ part: number; data: ArrayBuffer }>(
        "SELECT part,data FROM room_chunks WHERE kind=? AND id=? ORDER BY part",
        kind,
        id
      )
      .toArray();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const [i, row] of rows.entries()) {
      const chunk = new Uint8Array(row.data);
      if (
        row.part !== i ||
        chunk.length !== Math.min(CHUNK_BYTES, size - offset)
      ) {
        throw new Error("Incomplete room generation");
      }
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== size) {
      throw new Error("Incomplete room generation");
    }
    return bytes;
  }
  remove(kind: string, id: string) {
    this.storage.sql.exec(
      "DELETE FROM room_chunks WHERE kind=? AND id=?",
      kind,
      id
    );
    this.storage.sql.exec(
      "DELETE FROM room_meta WHERE key=?",
      `blob:${kind}:${id}`
    );
  }
  consume(jti: string, expires: number, now: number) {
    this.storage.sql.exec("DELETE FROM room_tickets WHERE expires<=?", now);
    this.storage.sql.exec(
      "INSERT INTO room_tickets VALUES (?,?)",
      jti,
      expires
    );
  }
}
