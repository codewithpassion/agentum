import { keySpec } from "@repo/services/crypto";

/**
 * The key spec `importRunTokenKey` takes: `RUN_TOKEN_KEY`, plus
 * `RUN_TOKEN_KEY_PREVIOUS` while a rotation is under way (docs/key-rotation.md).
 * Declared here, not read off `Env`, so the type check does not depend on a
 * developer's env file listing the previous key.
 */
export const runTokenKeySpec = (env: {
  RUN_TOKEN_KEY: string;
  RUN_TOKEN_KEY_PREVIOUS?: string;
}): string => keySpec(env.RUN_TOKEN_KEY, env.RUN_TOKEN_KEY_PREVIOUS);
