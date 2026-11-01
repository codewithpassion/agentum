/**
 * Requests in Slack. A run that asks for approval, an answer or a take-over posts a
 * card through its agent's own Slack app. `onEvent` posts the card when the
 * request opens and settles it when the request closes, whichever surface
 * answered. `interact` is everything the interactions route does before it
 * answers: check who is calling, read the click or the modal submission, and
 * hand the answer to the requests service. Anything slow comes back as an
 * `after` job, because Slack wants its answer within 3 seconds.
 */
import type { Database } from "@repo/db";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { identityLinks } from "@repo/db/schema/workspaces";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { findAgent } from "../agents.ts";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import type { EventRecord } from "../events.ts";
import { isA2aApproval } from "../mail/approval.ts";
import {
  outcomeOf,
  type RequestRow,
  requestRecord,
} from "../requests/records.ts";
import type { RequestsService } from "../requests.ts";
import { type Clock, replyTargetSchema } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import {
  createSecretReader,
  findAppByApiId,
  findInstalledApp,
  type SlackAppRow,
} from "./apps.ts";
import {
  createSlackClient,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";
import { describeFailure, withRetry } from "./post.ts";
import {
  type CardRequest,
  type InteractionResult,
  modalView,
  parseInteraction,
  requestCard,
  settledCard,
} from "./request-cards.ts";
import { verifySlackRequest } from "./signature.ts";

const CANT_ANSWER = "You can't answer this one.";
const TRAILING_SLASHES = /\/+$/;
const PEER_NAME_MAX = 100;

/** What `run_requests.slack_message` holds: the card, by Slack's `api_app_id`. */
const slackMessageSchema = z.strictObject({
  appId: z.string().min(1),
  channel: z.string().min(1),
  ts: z.string().min(1),
});

/** The parts of an interaction payload every kind of interaction carries. */
const headSchema = z.object({
  api_app_id: z.string().min(1),
  team: z.object({ id: z.string().min(1) }),
  type: z.string(),
  user: z.object({ id: z.string().min(1) }),
});

/** Where a click happened, so a refusal can be shown to the person alone. */
const placeSchema = z.object({
  channel: z.object({ id: z.string().min(1) }).optional(),
  container: z
    .object({
      channel_id: z.string().optional(),
      thread_ts: z.string().optional(),
    })
    .optional(),
  message: z.object({ thread_ts: z.string().optional() }).optional(),
});

export type InteractResult =
  | { kind: "malformed" }
  | { kind: "unauthorized" }
  | {
      /** Runs after the answer has gone out. */
      after?: () => Promise<void>;
      kind: "accepted";
      /** The JSON body to answer with. Without it the answer is empty. */
      response?: Record<string, unknown>;
    };

type Access =
  | { kind: "denied" }
  | { kind: "settled" }
  | { kind: "open"; principal: Principal };

interface Destination {
  app: SlackAppRow;
  channel: string;
  client: SlackClient;
  threadTs?: string;
}

const accepted = (
  after?: () => Promise<void>,
  response?: Record<string, unknown>
): InteractResult => ({ after, kind: "accepted", response });

export interface SlackRequestsOptions {
  clock: Clock;
  db: Database;
  /** Runs work after the response (`waitUntil`). Without it, the work is awaited. */
  defer?: (work: Promise<void>) => void;
  fetch: SlackFetch;
  publicBaseUrl?: string;
  requests: Pick<RequestsService, "answer" | "cancel" | "outcome">;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}

export const createSlackRequests = ({
  clock,
  db,
  defer,
  fetch: slackFetch,
  publicBaseUrl = "",
  requests,
  secretsKey,
}: SlackRequestsOptions) => {
  const secrets = createSecretReader(secretsKey);

  const clientOf = async (app: SlackAppRow): Promise<SlackClient | null> => {
    const token = await secrets.botToken(app);
    return token ? createSlackClient({ fetch: slackFetch, token }) : null;
  };

  const loadRow = async (requestId: string): Promise<RequestRow | null> => {
    const [row] = await db
      .select()
      .from(runRequests)
      .where(eq(runRequests.id, requestId))
      .limit(1);
    return row ?? null;
  };

  const cardOf = async (row: RequestRow): Promise<CardRequest> => {
    const agent = await findAgent(db, {
      id: row.agentId,
      workspaceId: row.workspaceId,
    });
    const { display } = requestRecord(row);
    if (!agent) {
      throw new Error("The request's agent is gone");
    }
    const base = {
      agentName: agent.name,
      expiresAt: Date.parse(row.expiresAt),
      requestId: row.id,
    };
    if ("machineId" in display) {
      return {
        ...base,
        publicBaseUrl,
        reason: display.reason,
        runId: row.runId,
      };
    }
    return "questions" in display
      ? { ...base, questions: display.questions }
      : {
          ...base,
          input: display.input,
          summary: display.summary,
          ...(display.peerRun ? { peerRun: true } : {}),
        };
  };

  /** The thread the run was started in, through the agent's app in that team. */
  const threadDestination = async (
    run: { agentId: string; workspaceId: string },
    reply: { channel: string; teamId: string; threadTs: string }
  ): Promise<Destination | null> => {
    const app = await findInstalledApp(db, {
      agentId: run.agentId,
      teamId: reply.teamId,
      workspaceId: run.workspaceId,
    });
    const client = app ? await clientOf(app) : null;
    return app && client
      ? { app, channel: reply.channel, client, threadTs: reply.threadTs }
      : null;
  };

  /**
   * A DM from the agent's app to the person the run is for, in the first Slack
   * team where they are linked and the agent has an installed app.
   */
  const dmDestination = async (run: {
    agentId: string;
    onBehalfOfUserId: string | null;
    workspaceId: string;
  }): Promise<Destination | null> => {
    if (!run.onBehalfOfUserId) {
      return null;
    }
    const links = await db
      .select({
        externalUserId: identityLinks.externalUserId,
        teamId: identityLinks.teamId,
      })
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.workspaceId, run.workspaceId),
          eq(identityLinks.provider, "slack"),
          eq(identityLinks.clerkUserId, run.onBehalfOfUserId)
        )
      );
    for (const link of links) {
      // biome-ignore lint/performance/noAwaitInLoops: the first team that works wins
      const app = await findInstalledApp(db, {
        agentId: run.agentId,
        teamId: link.teamId,
        workspaceId: run.workspaceId,
      });
      const client = app ? await clientOf(app) : null;
      if (!(app && client)) {
        continue;
      }
      const opened = await client.openDm(link.externalUserId);
      if (opened.kind === "ok") {
        return { app, channel: opened.channelId, client };
      }
    }
    return null;
  };

  const answeredByName = async (
    row: RequestRow,
    app: SlackAppRow,
    client: SlackClient
  ): Promise<string | undefined> => {
    if (row.kind !== "takeover" || !row.answeredBy) {
      return;
    }
    // There is no local person name: use Slack's name, then the linked email,
    // then the stored user id when that person is not linked in this team.
    const [link] = await db
      .select()
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.workspaceId, row.workspaceId),
          eq(identityLinks.provider, "slack"),
          eq(identityLinks.teamId, app.teamId),
          eq(identityLinks.clerkUserId, row.answeredBy)
        )
      )
      .limit(1);
    const name = link ? await client.userName(link.externalUserId) : null;
    return (
      (name?.kind === "ok" ? name.name : null) ?? link?.email ?? row.answeredBy
    );
  };

  /**
   * Closes the card of a request that is no longer pending. Safe to run more
   * than once, and a no-op when no card was posted.
   */
  const settle = async (requestId: string): Promise<void> => {
    const row = await loadRow(requestId);
    const outcome = row ? outcomeOf(row) : null;
    if (!(row && outcome && row.slackMessage !== null)) {
      return;
    }
    const message = slackMessageSchema.parse(JSON.parse(row.slackMessage));
    const app = await findAppByApiId(db, message.appId);
    const client = app ? await clientOf(app) : null;
    if (!client) {
      return;
    }
    const card = settledCard(await cardOf(row), {
      by: app ? await answeredByName(row, app, client) : undefined,
      outcome,
      via: row.answeredVia ?? undefined,
    });
    const updated = await withRetry(clock, () =>
      client.updateMessage({
        blocks: card.blocks,
        channel: message.channel,
        text: card.text,
        ts: message.ts,
      })
    );
    if (updated.kind !== "ok") {
      console.warn("Slack request card not settled", describeFailure(updated));
    }
  };

  /** Posts the card of a request that just opened, where its run can be answered from. */
  /**
   * A message to an outside agent waits for a person. A Slack block holds about
   * 3,000 characters and a person must see the whole message before it goes, so
   * Slack gets a plain notice with a link and no buttons. It is answered in
   * Harbourmaster, where the card shows in full. The notice is not kept as the
   * request's Slack message, so nothing edits it later.
   */
  const postSendNotice = async (
    row: typeof runRequests.$inferSelect,
    destination: Destination
  ): Promise<void> => {
    let peer = "an outside agent";
    try {
      const shown = (JSON.parse(row.display) as { input?: { peer?: unknown } })
        .input?.peer;
      if (typeof shown === "string") {
        peer =
          shown.length > PEER_NAME_MAX
            ? `${shown.slice(0, PEER_NAME_MAX)}…`
            : shown;
      }
    } catch {
      // The notice still says a message waits.
    }
    const link = publicBaseUrl
      ? ` Read it in full and answer at ${publicBaseUrl.replace(TRAILING_SLASHES, "")}/desk?item=${encodeURIComponent(row.id)}`
      : " Open Harbourmaster to read it in full and answer.";
    const posted = await withRetry(clock, () =>
      destination.client.postMessage({
        channel: destination.channel,
        text: `A message to ${peer} is waiting for approval.${link}`,
        threadTs: destination.threadTs,
      })
    );
    if (posted.kind !== "ok") {
      console.warn("Slack notice not posted", describeFailure(posted));
    }
  };

  const postCard = async (requestId: string): Promise<void> => {
    const row = await loadRow(requestId);
    if (!row || row.slackMessage !== null || row.status !== "pending") {
      return;
    }
    const [run] = await db
      .select({
        agentId: runs.agentId,
        onBehalfOfUserId: runs.onBehalfOfUserId,
        reply: runs.reply,
        workspaceId: runs.workspaceId,
      })
      .from(runs)
      .where(eq(runs.id, row.runId))
      .limit(1);
    if (!run) {
      return;
    }
    const reply =
      run.reply === null
        ? null
        : replyTargetSchema.parse(JSON.parse(run.reply));
    const destination =
      reply?.kind === "slack"
        ? await threadDestination(run, reply)
        : await dmDestination(run);
    if (!destination) {
      return;
    }
    if (isA2aApproval(row)) {
      await postSendNotice(row, destination);
      return;
    }
    const request = await cardOf(row);
    const card = requestCard(request);
    const posted = await withRetry(clock, () =>
      destination.client.postMessage({
        blocks: card.blocks,
        channel: destination.channel,
        text: card.text,
        threadTs: destination.threadTs,
      })
    );
    if (posted.kind !== "ok") {
      console.warn("Slack request card not posted", describeFailure(posted));
      return;
    }
    await db
      .update(runRequests)
      .set({
        slackMessage: JSON.stringify({
          appId: destination.app.appId,
          channel: destination.channel,
          ts: posted.ts,
        }),
      })
      .where(eq(runRequests.id, row.id));
    // The request may have closed while the card was on its way.
    await settle(row.id);
  };

  /**
   * The `events.onAppend` listener. The Slack calls run after the response
   * when `defer` is given, and a failure is logged, never thrown.
   */
  const onEvent = async (event: EventRecord): Promise<void> => {
    const { requestId } = event.payload;
    if (typeof requestId !== "string") {
      return;
    }
    let work: ((id: string) => Promise<void>) | undefined;
    if (event.type === "request.opened") {
      work = postCard;
    } else if (
      event.type === "request.answered" ||
      event.type === "request.expired" ||
      event.type === "request.cancelled"
    ) {
      work = settle;
    }
    if (!work) {
      return;
    }
    const job = work(requestId).catch((error: unknown) => {
      console.error("Slack request card failed", error);
    });
    if (defer) {
      defer(job);
      return;
    }
    await job;
  };

  /** The Harbourmaster user behind a Slack user, as the principal that answers. */
  const principalOf = async (
    app: SlackAppRow,
    slackUserId: string
  ): Promise<Principal | null> => {
    const [link] = await db
      .select({ clerkUserId: identityLinks.clerkUserId })
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.workspaceId, app.workspaceId),
          eq(identityLinks.provider, "slack"),
          eq(identityLinks.teamId, app.teamId),
          eq(identityLinks.externalUserId, slackUserId)
        )
      )
      .limit(1);
    return link
      ? {
          kind: "user",
          userId: link.clerkUserId,
          via: "slack",
          workspaceId: app.workspaceId,
        }
      : null;
  };

  /** Whether this Slack user may answer the request, and whether it is still open. */
  const accessOf = async (
    app: SlackAppRow,
    requestId: string,
    slackUserId: string
  ): Promise<Access> => {
    const principal = await principalOf(app, slackUserId);
    if (!principal) {
      return { kind: "denied" };
    }
    try {
      // Reading the outcome runs the same checks as answering: the person
      // must see the run's session.
      const outcome = await requests.outcome(principal, requestId);
      return outcome ? { kind: "settled" } : { kind: "open", principal };
    } catch (error) {
      if (isServiceError(error) || error instanceof ForbiddenError) {
        return { kind: "denied" };
      }
      throw error;
    }
  };

  /** Tells one person they can't answer, in a message nobody else sees. */
  const refuse = async (
    app: SlackAppRow,
    payload: unknown,
    slackUserId: string
  ): Promise<void> => {
    const place = placeSchema.safeParse(payload);
    const channel =
      place.data?.channel?.id ?? place.data?.container?.channel_id;
    const client = channel ? await clientOf(app) : null;
    if (!(channel && client)) {
      return;
    }
    await withRetry(clock, () =>
      client.postEphemeral({
        channel,
        text: CANT_ANSWER,
        threadTs:
          place.data?.message?.thread_ts ?? place.data?.container?.thread_ts,
        user: slackUserId,
      })
    );
  };

  const answer = async (
    principal: Principal,
    requestId: string,
    parsed: Extract<InteractionResult, { ok: true }>
  ): Promise<void> => {
    try {
      if (parsed.cancel) {
        await requests.cancel(principal, requestId);
      } else {
        await requests.answer(principal, {
          answer: parsed.answer,
          requestId,
          via: "slack",
        });
      }
    } catch (error) {
      // The other surface was first: show its result on this card.
      if (isServiceError(error) && error.code === "conflict") {
        await settle(requestId);
        return;
      }
      throw error;
    }
  };

  const openModal = async (
    app: SlackAppRow,
    row: RequestRow,
    triggerId: string | undefined
  ): Promise<void> => {
    const request = await cardOf(row);
    const client = triggerId ? await clientOf(app) : null;
    if (!(triggerId && client && "questions" in request)) {
      return;
    }
    const opened = await client.openView({
      triggerId,
      view: modalView(request),
    });
    if (opened.kind !== "ok") {
      console.warn("Slack modal not opened", describeFailure(opened));
    }
  };

  /** Runs a deferred interaction job; a failure is logged, never thrown. */
  const guarded = (job: () => Promise<void>) => async (): Promise<void> => {
    try {
      await job();
    } catch (error) {
      console.error("Slack interaction failed", error);
    }
  };

  const submit = async (
    app: SlackAppRow,
    row: RequestRow,
    slackUserId: string,
    parsed: Extract<InteractionResult, { ok: true }>
  ): Promise<InteractResult> => {
    const access = await accessOf(app, row.id, slackUserId);
    if (access.kind === "denied") {
      return accepted(undefined, {
        errors: { q0: CANT_ANSWER },
        response_action: "errors",
      });
    }
    return accepted(
      guarded(() =>
        access.kind === "settled"
          ? settle(row.id)
          : answer(access.principal, row.id, parsed)
      )
    );
  };

  const canInteract = (row: RequestRow, parsed: InteractionResult): boolean =>
    row.kind !== "takeover" || (parsed.ok && parsed.cancel === true);

  /** A click or submission from an app whose signature and team were checked. */
  const handle = async (
    app: SlackAppRow,
    head: z.infer<typeof headSchema>,
    payload: unknown
  ): Promise<InteractResult> => {
    const first = parseInteraction(payload);
    const requestId = "requestId" in first ? first.requestId : undefined;
    const row = requestId ? await loadRow(requestId) : null;
    // A request of another workspace or agent is not this app's to answer.
    if (
      !row ||
      row.workspaceId !== app.workspaceId ||
      row.agentId !== app.agentId
    ) {
      return accepted();
    }
    const { display } = requestRecord(row);
    const parsed = parseInteraction(
      payload,
      "questions" in display ? display.questions : undefined
    );
    // Takeover control and hand-back require the browser; Slack only cancels.
    if (!canInteract(row, parsed)) {
      return accepted();
    }
    const slackUserId = head.user.id;
    if (head.type === "view_submission") {
      if (!parsed.ok) {
        return accepted();
      }
      return submit(app, row, slackUserId, parsed);
    }
    if (!parsed.ok && parsed.reason !== "modal_required") {
      return accepted();
    }
    return accepted(
      guarded(async () => {
        const access = await accessOf(app, row.id, slackUserId);
        if (access.kind === "denied") {
          await refuse(app, payload, slackUserId);
        } else if (access.kind === "settled") {
          await settle(row.id);
        } else if (parsed.ok) {
          await answer(access.principal, row.id, parsed);
        } else {
          await openModal(app, row, parsed.triggerId);
        }
      })
    );
  };

  /**
   * Authenticates and reads one interaction. `rawBody` is the form body exactly
   * as Slack sent it, with the JSON in its `payload` field.
   */
  const interact = async (request: {
    rawBody: string;
    signature: string;
    timestamp: string;
  }): Promise<InteractResult> => {
    let payload: unknown;
    try {
      const raw = new URLSearchParams(request.rawBody).get("payload");
      payload = raw === null ? undefined : JSON.parse(raw);
    } catch {
      return { kind: "malformed" };
    }
    const head = headSchema.safeParse(payload);
    if (!head.success) {
      return { kind: "malformed" };
    }
    const app = await findAppByApiId(db, head.data.api_app_id);
    if (!app) {
      console.warn("Slack interaction refused: unknown app");
      return { kind: "unauthorized" };
    }
    const verified = await verifySlackRequest({
      body: request.rawBody,
      now: clock.now().getTime(),
      signature: request.signature,
      signingSecret: await secrets.signingSecret(app),
      timestamp: request.timestamp,
    });
    if (!verified || head.data.team.id !== app.teamId) {
      return { kind: "unauthorized" };
    }
    return await handle(app, head.data, payload);
  };

  return { interact, onEvent };
};

export type SlackRequests = ReturnType<typeof createSlackRequests>;
