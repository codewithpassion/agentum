import { Link } from "@tanstack/react-router";
import type { MarkdownLinkProps } from "#/components/workspace/markdown";
import { useWorkspaceSlug } from "#/lib/workspace-context";
import { nodeText } from "#/modules/wiki/slug";
import { wikiSlugFromHref } from "#/modules/wiki/wiki-links";

/**
 * Resolves the links inside a rendered page: `[[Wiki Links]]` (already rewritten
 * to `/wiki/<slug>`) become in-app navigation, heading anchors stay native so
 * the browser scrolls and updates the hash, and anything else leaves the app.
 *
 * A link to a page nobody has written yet is styled as missing and carries the
 * title along, so the target route can offer to create exactly that page.
 */
export const createWikiLinkRenderer = (knownSlugs: ReadonlySet<string>) =>
  function WikiLink({ children, href }: MarkdownLinkProps) {
    const workspaceSlug = useWorkspaceSlug();
    const slug = href ? wikiSlugFromHref(href) : null;

    if (slug) {
      const exists = knownSlugs.has(slug);
      return (
        <Link
          className={exists ? undefined : "wiki-link-missing"}
          params={{ _splat: slug, workspaceSlug }}
          search={exists ? {} : { title: nodeText(children) }}
          title={exists ? undefined : "This page does not exist yet"}
          to="/w/$workspaceSlug/wiki/$"
        >
          {children}
        </Link>
      );
    }

    if (href?.startsWith("#")) {
      return <a href={href}>{children}</a>;
    }

    return (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  };
