import {
  FEATURE_LIBRARY_LIVE,
  FEATURE_LIBRARY_SYNC,
  FEATURE_REQUESTS,
} from "@repo/protocol/machine";
import pkg from "../package.json";

export const DAEMON_VERSION: string = pkg.version;

/** The optional features this daemon understands, sent with its claim and its hello. */
export const DAEMON_FEATURES = [
  FEATURE_LIBRARY_SYNC,
  FEATURE_REQUESTS,
  FEATURE_LIBRARY_LIVE,
] as const;

/** The exact Agent SDK version the daemon is built with, as `hello` reports it. */
export const AGENT_SDK: string = `claude-agent-sdk@${pkg.dependencies["@anthropic-ai/claude-agent-sdk"]}`;
