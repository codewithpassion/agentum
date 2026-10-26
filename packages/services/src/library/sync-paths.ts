// The library folders an agent syncs into its working copy: its home, the wiki
// and its grants (`librarySyncScope`).
import type { LibraryAccessGrant } from "@repo/db/shared";
import { agentHomePath } from "./home.ts";
import { normalizePath } from "./path.ts";

/** Home and wiki are implicit grants. Explicit grants add access, never revoke it. */
export const librarySyncScope = (
  slug: string,
  grants: readonly LibraryAccessGrant[]
): LibraryAccessGrant[] => {
  const byPath = new Map<string, LibraryAccessGrant>();
  for (const grant of [
    { mode: "write" as const, path: agentHomePath(slug) },
    { mode: "read" as const, path: "wiki" },
    ...grants,
  ]) {
    const path = normalizePath(grant.path);
    const previous = byPath.get(path);
    byPath.set(path, {
      mode: previous?.mode === "write" ? "write" : grant.mode,
      path,
    });
  }
  const roots = [...byPath.values()];
  // Drop covered roots only when the outer grant conveys at least as much access.
  // A nested write under a read grant must survive to preserve the service rule.
  return roots.filter(
    (root) =>
      !roots.some(
        (other) =>
          other !== root &&
          root.path.startsWith(`${other.path}/`) &&
          (other.mode === "write" || root.mode === "read")
      )
  );
};
