import type { DictationAdapter } from "#/components/dictation/index.ts";
import { getTrpc } from "#/integrations/trpc/client";
export const dictationAdapter: DictationAdapter = {
  polish: (input) => getTrpc().dictation.polish.mutate(input),
  status: () => getTrpc().dictation.status.query(),
  transcribe: (input) => getTrpc().dictation.transcribe.mutate(input),
};
