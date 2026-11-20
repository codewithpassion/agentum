import {
  type CompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
} from "@earendil-works/pi-durable";
import {
  CONTEXT_BUDGET_COMPACTION_TOKENS,
  type ContextBudget,
} from "@repo/db/shared";

/**
 * The compaction policy for a run on a model with `contextWindow` tokens, for an
 * agent with `budget`. Pi compacts when the context passes `contextWindow -
 * reserveTokens`, so the reserve is set to compact at the budget's token count. A
 * model whose window is at or below that count keeps Pi's default reserve. Returns
 * `{}`, Pi's defaults, when the budget is unset or the window is not a positive
 * finite number.
 */
export const compactionPolicyFor = (
  budget: ContextBudget | undefined,
  contextWindow: number | undefined
): Partial<CompactionPolicy> => {
  if (budget === undefined || contextWindow === undefined) {
    return {};
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return {};
  }
  const compactAtTokens = CONTEXT_BUDGET_COMPACTION_TOKENS[budget];
  return {
    reserveTokens: Math.max(
      DEFAULT_COMPACTION_POLICY.reserveTokens,
      contextWindow - compactAtTokens
    ),
  };
};
