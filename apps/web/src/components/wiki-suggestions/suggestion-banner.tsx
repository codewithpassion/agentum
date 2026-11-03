import { useCallback, useEffect, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { SuggestionReview } from "./suggestion-review.tsx";

interface SuggestionBannerProps {
  /** A suggestion was accepted or rejected, so the parent can reread the page. */
  onDecided: () => void;
  path: string;
  /** Goes up when the page refetches. The banner then reloads its suggestions. */
  refreshTick: number;
}

type Suggestion = RouterOutputs["wiki"]["suggestions"]["list"][number];

interface SuggestionList {
  agentNames: Map<string, string>;
  suggestions: Suggestion[];
}

/** The suggested edits that concern one wiki page, each with its review controls. */
export function SuggestionBanner({
  onDecided,
  path,
  refreshTick,
}: SuggestionBannerProps) {
  const [list, setList] = useState<SuggestionList>({
    agentNames: new Map(),
    suggestions: [],
  });
  // Bumped when a review decides a suggestion, so the list reloads.
  const [reloadCount, setReloadCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadCount only triggers a reload
  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const [suggestions, agents] = await Promise.all([
          getTrpc().wiki.suggestions.list.query(),
          getTrpc().agents.list.query({}),
        ]);
        if (current) {
          setList({
            agentNames: new Map(agents.map((agent) => [agent.id, agent.name])),
            suggestions: suggestions.filter((item) => item.path === path),
          });
        }
      } catch {
        // Keep the last list. A banner that cannot load is not worth an error.
      }
    };
    load();
    return () => {
      current = false;
    };
  }, [path, refreshTick, reloadCount]);

  const handleDecided = useCallback(() => {
    setReloadCount((count) => count + 1);
    onDecided();
  }, [onDecided]);

  if (list.suggestions.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Suggested edits"
      className="flex flex-col gap-3"
      data-testid="wiki-suggestions"
    >
      {list.suggestions.map((suggestion) => {
        const agentName = list.agentNames.get(suggestion.agentId) ?? "An agent";
        return (
          <div
            className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
            data-testid="wiki-suggestion"
            key={suggestion.id}
          >
            <h3 className="font-semibold">
              {agentName} suggested an edit to this page
            </h3>
            <SuggestionReview
              agentName={agentName}
              id={suggestion.id}
              onDecided={handleDecided}
            />
          </div>
        );
      })}
    </section>
  );
}
