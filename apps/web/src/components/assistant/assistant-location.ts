import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

/** Change only the assistant parameter, including on pages with unrecognised search keys. */
export function assistantHref(href: string, conversationId: string | null) {
  const url = new URL(href, "http://localhost");
  if (conversationId === null) {
    url.searchParams.delete("assistant");
  } else {
    url.searchParams.set("assistant", conversationId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useAssistantLocation() {
  const router = useRouter();
  const conversationId = useRouterState({
    select: (state) =>
      new URLSearchParams(state.location.searchStr).get("assistant") || null,
  });
  const open = useCallback(
    (id: string | null, replace = false) => {
      const href = assistantHref(router.state.location.href, id);
      if (replace) {
        router.history.replace(href);
      } else {
        router.history.push(href);
      }
    },
    [router]
  );
  return { conversationId, open };
}
