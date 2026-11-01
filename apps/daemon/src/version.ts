import {
  FEATURE_CURRENT_APPROVALS,
  FEATURE_LIBRARY_LIVE,
  FEATURE_LIBRARY_SYNC,
  FEATURE_REQUESTS,
} from "@repo/protocol/machine";
import pkg from "../package.json";

/**
 * The build's version. A release build embeds `<package version>+<short commit>`
 * through `bun build --define process.env.HM_DAEMON_VERSION=...`, so the real
 * build reports itself. Without a define the package version stands.
 */
export const resolveVersion = (
  embedded: string | undefined,
  packageVersion: string
): string =>
  embedded === undefined || embedded === "" ? packageVersion : embedded;

export const DAEMON_VERSION: string = resolveVersion(
  process.env.HM_DAEMON_VERSION,
  pkg.version
);

/** The optional features this daemon understands, sent with its claim and its hello. */
export const DAEMON_FEATURES = [
  FEATURE_LIBRARY_SYNC,
  FEATURE_REQUESTS,
  FEATURE_LIBRARY_LIVE,
  FEATURE_CURRENT_APPROVALS,
] as const;

/** The exact Agent SDK version the daemon is built with, as `hello` reports it. */
export const AGENT_SDK: string = `claude-agent-sdk@${pkg.dependencies["@anthropic-ai/claude-agent-sdk"]}`;
