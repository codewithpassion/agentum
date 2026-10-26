// The library and wiki tools' view of the library and wiki services, bound to
// the caller's principal like `createSkillPorts`. Each member is a thin call, so
// the services' `authorize`, path and access rules apply as they do in the UI.
import type {
  LibraryEntryInfo,
  LibraryVersionInfo,
  McpPorts,
} from "@repo/mcp/ports";
import type { LibraryEntry } from "@repo/services/library";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { guarded } from "./guarded.ts";

export type LibraryPorts = Pick<
  McpPorts,
  | "libraryList"
  | "libraryRead"
  | "libraryVersions"
  | "libraryWrite"
  | "wikiRead"
  | "wikiSuggestEdit"
>;

const toEntryInfo = (entry: LibraryEntry): LibraryEntryInfo => ({
  etag: entry.etag,
  kind: entry.kind,
  mtime: entry.mtime,
  path: entry.path,
  size: entry.size,
  updatedBy: entry.updatedBy,
});

export const createLibraryPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: Services;
}): LibraryPorts => {
  const { library, wiki, wikiSuggestions } = services;
  return {
    libraryList: ({ dir }) =>
      guarded(async () =>
        (await library.list(principal, dir)).map(toEntryInfo)
      ),

    libraryRead: ({ path }) =>
      guarded(async () => {
        const { bytes, entry } = await library.read(principal, path);
        return { bytes, entry: toEntryInfo(entry) };
      }),

    libraryVersions: ({ path }) =>
      guarded(async () =>
        (await library.versions(principal, path)).map(
          (version): LibraryVersionInfo => ({
            authorId: version.authorId,
            authorKind: version.authorKind,
            createdAt: version.createdAt,
            etag: version.etag,
            id: version.id,
            op: version.op,
            path: version.path,
            runId: version.runId,
            sha256: version.sha256,
            size: version.size,
            version: version.version,
          })
        )
      ),

    libraryWrite: ({ bytes, ifEtag, path }) =>
      guarded(async () =>
        toEntryInfo(
          await library.write(
            principal,
            path,
            bytes,
            ifEtag === undefined ? {} : { ifEtag }
          )
        )
      ),

    wikiRead: ({ path }) => guarded(() => wiki.page(principal, path)),

    wikiSuggestEdit: ({ body, path, summary }) =>
      guarded(async () => {
        const suggestion = await wikiSuggestions.suggest(
          principal,
          path,
          body,
          summary
        );
        return { id: suggestion.id };
      }),
  };
};
