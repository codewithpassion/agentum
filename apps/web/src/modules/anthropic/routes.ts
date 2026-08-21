import { type Context, Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { badRequest, readJsonObject, requireString } from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { requireOwner } from "#/modules/workspaces/require-workspace";
import { resyncWorkspaceAfterKeyChange } from "./service";
import {
  ANTHROPIC_KEY_MAX_LENGTH,
  ANTHROPIC_KEY_PREFIX,
  deleteWorkspaceAnthropicKey,
  getWorkspaceAnthropicKeyStatus,
  isAnthropicKeyShaped,
  setWorkspaceAnthropicKey,
  validateAnthropicKey,
} from "./workspace-keys";

/**
 * `/api/w/:workspaceSlug/anthropic-key` - the workspace's own API key.
 *
 * Owner-only throughout, and write-only: all three verbs answer the same
 * status shape, which says whether a key is configured and shows its last four
 * characters. The key itself is never in a response, in an error message or in
 * a log, including when Anthropic has just rejected it.
 */

const UNPROCESSABLE_CONTENT = 422;
const SERVICE_UNAVAILABLE = 503;

/**
 * Behind the response, like every other push to Anthropic: changing the key
 * forgot every id the workspace held, and its agents have to be registered
 * again under the new one. A failure here is not lost - the reset recorded the
 * push as owed, and the existing pending sweep retries it.
 */
const reregister = (c: Context<ApiEnv>, db: Db): void => {
  const work = resyncWorkspaceAfterKeyChange(
    db,
    c.env,
    c.get("workspace").id,
    c.req.url
  ).catch(() => {
    // Every failure path records itself on the agent row.
  });
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a direct fetch in a test): let it run detached.
  }
};

export const anthropicKeyRoutes = new Hono<ApiEnv>();

// `requireAuth` and `requireWorkspace` come from the mount; this is the extra
// gate, applied to every verb because reading the hint is an owner's business
// as much as changing the key is.
anthropicKeyRoutes.use("*", requireOwner);

anthropicKeyRoutes.get("/", async (c) =>
  c.json(
    await getWorkspaceAnthropicKeyStatus(
      createDb(c.env.DB),
      c.get("workspace").id
    )
  )
);

anthropicKeyRoutes.put("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const apiKey = requireString(body, "apiKey", {
    maxLength: ANTHROPIC_KEY_MAX_LENGTH,
  });
  if (!isAnthropicKeyShaped(apiKey)) {
    throw badRequest(
      `"apiKey" does not look like an Anthropic API key - those start with ${ANTHROPIC_KEY_PREFIX}.`
    );
  }

  // Before the network call: with no `CONNECTOR_KEY` there is nothing to
  // encrypt with, so a valid key could not be stored anyway.
  if (!c.env.CONNECTOR_KEY) {
    return c.json(
      { error: "This deployment cannot store API keys. Contact your admin." },
      SERVICE_UNAVAILABLE
    );
  }

  if (!(await validateAnthropicKey(apiKey))) {
    return c.json(
      {
        error: "Anthropic did not accept that key. Check it and try again.",
      },
      UNPROCESSABLE_CONTENT
    );
  }

  const db = createDb(c.env.DB);
  const status = await setWorkspaceAnthropicKey(db, c.env, {
    apiKey,
    clerkUserId: c.get("userId"),
    workspaceId: c.get("workspace").id,
  });
  reregister(c, db);
  return c.json(status);
});

/** Idempotent: a workspace with no key of its own is already on the global one. */
anthropicKeyRoutes.delete("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = await deleteWorkspaceAnthropicKey(db, c.get("workspace").id);
  reregister(c, db);
  return c.json(status);
});
