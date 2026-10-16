import pkg from "../package.json";

export const DAEMON_VERSION: string = pkg.version;

/** The exact Agent SDK version the daemon is built with, as `hello` reports it. */
export const AGENT_SDK: string = `claude-agent-sdk@${pkg.dependencies["@anthropic-ai/claude-agent-sdk"]}`;
