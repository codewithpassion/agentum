import type { Gateway } from "./types.ts";

/** The gateway for a run with no reply target: delivers nothing. */
export const noneGateway: Gateway = {
  deliver: () => Promise.resolve(),
  kind: "none",
};
