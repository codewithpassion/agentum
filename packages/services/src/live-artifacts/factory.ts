import { createLiveAskService, type LiveAskDeps } from "./ask.ts";
import { createLiveMentions, type LiveMentionPort } from "./mentions.ts";
import {
  createLiveArtifactsService,
  type LiveArtifactsDeps,
} from "./service.ts";

/** RunsService is built first. Ask only depends on DB/access and trusted room
 * ports, so comments can then consume its real LiveAskPort without late/no-op wiring. */
export const createLiveArtifactsWithAsk = (
  deps: Omit<LiveArtifactsDeps, "ask"> &
    Pick<LiveAskDeps, "runs" | "presence" | "resolveMember"> & {
      mentions?: LiveMentionPort;
    }
) => {
  const asks = createLiveAskService(deps);
  const core = createLiveArtifactsService({ ...deps, ask: asks });
  return { ...core, ...asks, ...createLiveMentions(deps) };
};
export type LiveArtifactsWithAsk = ReturnType<
  typeof createLiveArtifactsWithAsk
>;
