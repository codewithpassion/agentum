import { useCallback, useEffect, useState } from "react";
import { isNotFound, type WikiPage, type WikiPageSummary } from "./api";
import { useApi } from "./workspace-context";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface WikiPagesState {
  error: string | null;
  pages: WikiPageSummary[];
  reload: () => Promise<void>;
}

/** The page list is small and is refetched after any mutation. */
export const useWikiPages = (enabled: boolean): WikiPagesState => {
  const api = useApi();
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setPages(await api.listWikiPages());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load the wiki."));
    }
  }, [api]);

  useEffect(() => {
    if (enabled) {
      reload();
    }
  }, [enabled, reload]);

  return { error, pages, reload };
};

export interface WikiPageState {
  error: string | null;
  loading: boolean;
  /** True when the slug has no page - the wiki-link "create it" case. */
  missing: boolean;
  page: WikiPage | null;
  setPage: (page: WikiPage) => void;
}

export const useWikiPage = (
  slug: string | null,
  enabled: boolean
): WikiPageState => {
  const api = useApi();
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!(enabled && slug)) {
      setPage(null);
      setMissing(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api
      .getWikiPage(slug)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        setPage(loaded);
        setMissing(false);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setPage(null);
        setMissing(isNotFound(cause));
        setError(
          isNotFound(cause) ? null : messageOf(cause, "Failed to load.")
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, enabled, slug]);

  return { error, loading, missing, page, setPage };
};
