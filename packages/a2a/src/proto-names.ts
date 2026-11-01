/**
 * ProtoJSON parsers accept a field under its lowerCamelCase name or its proto
 * name (`taskId` or `task_id`), and the official TCK sends the proto names on
 * JSON-RPC. `acceptProtoNames` renames the proto spelling to camelCase, so the
 * schemas only know one. `metadata` and `data` hold free-form JSON that the
 * sender owns, so their contents are left as they are.
 */

const FREE_FORM = new Set(["data", "metadata"]);
const SNAKE = /_([a-z0-9])/g;

const camel = (key: string): string =>
  key.replace(SNAKE, (_match, next: string) => next.toUpperCase());

export const acceptProtoNames = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(acceptProtoNames);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = camel(key);
    // The camelCase spelling wins when a sender gave both.
    if (name !== key && Object.hasOwn(value, name)) {
      continue;
    }
    out[name] = FREE_FORM.has(name) ? item : acceptProtoNames(item);
  }
  return out;
};
