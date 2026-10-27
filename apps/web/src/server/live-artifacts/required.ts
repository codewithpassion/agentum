import type { Services } from "../compose";
export const requiredLive = (services: Pick<Services, "liveArtifacts">) => {
  if (!services.liveArtifacts) {
    throw new Error("Live artifacts are unavailable");
  }
  return services.liveArtifacts;
};
