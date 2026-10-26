import type { Database } from "@repo/db";
import type { Statement } from "@repo/db/atomic";
import { libraryEntries, libraryLinks } from "@repo/db/schema/library";
import { and, asc, eq, or } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { normalizePath, parentOf } from "../library/path.ts";
import type { LibraryLinkIndex, LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import { headingAnchors } from "./heading-anchors.ts";
import { parseWikiLinks } from "./links.ts";
import { leafTitle, slugifyPath } from "./slug.ts";

const MARKDOWN_EXTENSION = /\.md$/;
const isPage = (path: string) =>
  path.startsWith("wiki/") && path.endsWith(".md");
const targetKey = (title: string) => `wiki/${slugifyPath(title)}.md`;

/** Store unresolved targets too: creating a target needs no source-page rewrite. */
export const createWikiLinkIndex =
  ({ db }: { db: Database }): LibraryLinkIndex =>
  (workspaceId, changes) => {
    const statements: Statement[] = [];
    for (const { path, bytes } of changes) {
      if (!isPage(path)) {
        continue;
      }
      statements.push(
        db
          .delete(libraryLinks)
          .where(
            and(
              eq(libraryLinks.workspaceId, workspaceId),
              eq(libraryLinks.fromPath, path)
            )
          )
      );
      if (bytes === null) {
        continue;
      }
      const targets = new Set(
        parseWikiLinks(new TextDecoder().decode(bytes)).map(
          (link) => link.title
        )
      );
      // One row per statement keeps even large pages below D1's bind limit.
      for (const target of targets) {
        statements.push(
          db.insert(libraryLinks).values({
            fromPath: path,
            target,
            targetKey: targetKey(target),
            workspaceId,
          })
        );
      }
    }
    return statements;
  };

export interface WikiPageNode {
  children: WikiPageNode[];
  /** A folder node uses its library directory path, a page its .md path. */
  path: string;
  title: string;
}

export const createWikiService = ({
  db,
  library,
}: {
  db: Database;
  library: LibraryService;
}) => {
  const member = (principal: Principal) => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      throw new ForbiddenError("wiki.read");
    }
    authorize(principal, "library.read", {
      kind: "library",
      workspaceId: principal.workspaceId,
    });
    return principal;
  };
  const pagePath = (raw: string) => {
    const path = normalizePath(raw);
    if (!isPage(path)) {
      throw new ServiceError(
        "invalid",
        "A wiki page must be a wiki/**/*.md library path"
      );
    }
    return path;
  };
  const titleOf = (path: string, body: string) =>
    headingAnchors(body).find((heading) => heading.level === 1)?.text ||
    path.split("/").at(-1)?.slice(0, -3) ||
    "Untitled";
  const entries = (workspaceId: string) =>
    db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.workspaceId, workspaceId))
      .orderBy(asc(libraryEntries.path));
  const literalPath = (target: string) => {
    // Literal fallback is exact: malformed paths are broken links, not page-read errors.
    try {
      return normalizePath(target) === target ? target : null;
    } catch {
      return null;
    }
  };
  const resolve = (target: string, present: Map<string, string>) => {
    const wiki = targetKey(target);
    if (present.get(wiki) === "file") {
      return { broken: false, path: wiki };
    }
    const literal = literalPath(target);
    // Literal library links may name folders as well as files.
    if (literal && present.has(literal)) {
      return { broken: false, path: literal };
    }
    return { broken: true, path: wiki };
  };
  const page = async (principal: Principal, rawPath: string) => {
    const caller = member(principal);
    const path = pagePath(rawPath);
    const { bytes } = await library.read(principal, path);
    const body = new TextDecoder().decode(bytes);
    const present = new Map(
      (await entries(caller.workspaceId)).map((entry) => [
        entry.path,
        entry.kind,
      ])
    );
    const indexed = await db
      .select()
      .from(libraryLinks)
      .where(
        and(
          eq(libraryLinks.workspaceId, caller.workspaceId),
          or(eq(libraryLinks.targetKey, path), eq(libraryLinks.target, path))
        )
      )
      .orderBy(asc(libraryLinks.fromPath));
    const sources = [
      ...new Set(
        indexed
          .filter((link) => resolve(link.target, present).path === path)
          .map((link) => link.fromPath)
      ),
    ];
    const backlinks = await Promise.all(
      sources.map(async (source) => {
        const { bytes: content } = await library.read(principal, source);
        return {
          path: source,
          title: titleOf(source, new TextDecoder().decode(content)),
        };
      })
    );
    return {
      backlinks,
      body,
      links: parseWikiLinks(body).map((link) => ({
        ...link,
        ...resolve(link.title, present),
      })),
      path,
      title: titleOf(path, body),
    };
  };
  const pages = async (principal: Principal): Promise<WikiPageNode[]> => {
    const caller = member(principal);
    const rows = (await entries(caller.workspaceId)).filter(
      (row) => row.kind === "file" && isPage(row.path)
    );
    const nodes = new Map<string, WikiPageNode>();
    await Promise.all(
      rows.map(async (row) => {
        const { bytes } = await library.read(principal, row.path);
        nodes.set(row.path.slice(0, -3), {
          children: [],
          path: row.path,
          title: titleOf(row.path, new TextDecoder().decode(bytes)),
        });
      })
    );
    // A page foo.md owns folder foo/. Missing parent pages become folder nodes.
    for (const row of rows) {
      let dir = parentOf(row.path);
      while (dir !== "wiki") {
        if (!nodes.has(dir)) {
          nodes.set(dir, {
            children: [],
            path: dir,
            title: dir.split("/").at(-1) ?? dir,
          });
        }
        dir = parentOf(dir);
      }
    }
    const roots: WikiPageNode[] = [];
    for (const [key, node] of nodes) {
      const parent = nodes.get(parentOf(key));
      (parent?.children ?? roots).push(node);
    }
    const sort = (list: WikiPageNode[]) => {
      list.sort(
        (a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)
      );
      for (const node of list) {
        sort(node.children);
      }
    };
    sort(roots);
    return roots;
  };
  const createPage = async (
    principal: Principal,
    rawTitle: string,
    parent?: string
  ) => {
    member(principal);
    const title = rawTitle.trim();
    if (!title || title.includes("\n") || title.includes("\r")) {
      throw new ServiceError("invalid", "A single-line title is required");
    }
    // Parent accepts either a library folder or its parent page's .md path.
    const dir = parent
      ? normalizePath(parent).replace(MARKDOWN_EXTENSION, "")
      : "wiki";
    if (dir !== "wiki" && !dir.startsWith("wiki/")) {
      throw new ServiceError("invalid", "Parent must be inside wiki/");
    }
    const path = pagePath(`${dir}/${slugifyPath(title)}.md`);
    const existing = (await entries(member(principal).workspaceId)).some(
      (entry) => entry.path === path
    );
    if (existing) {
      throw new ServiceError("conflict", "Page already exists");
    }
    await library.write(
      principal,
      path,
      new TextEncoder().encode(`# ${leafTitle(title)}\n`)
    );
    return await page(principal, path);
  };
  return { createPage, page, pages };
};

export type WikiService = ReturnType<typeof createWikiService>;
