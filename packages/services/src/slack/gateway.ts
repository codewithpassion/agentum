/**
 * The Slack gateway (contract C7). `deliver` posts a run's answer in its
 * thread, and sends a Connect link only to the person the run is for.
 * `downloadPendingFiles` turns the Slack file descriptors a message arrived
 * with into stored files. Both look up the agent's installed Slack app for the
 * bot token and never read the environment.
 */
import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { identityLinks } from "@repo/db/schema/workspaces";
import { MAX_FILE_BYTES } from "@repo/db/shared";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { type Payload, payloadSchema } from "../events/payload.ts";
import type { EventRecord, EventsService } from "../events.ts";
import type { FilesService } from "../files.ts";
import {
  type Clock,
  type DeliveryContext,
  type Gateway,
  type ReplyTarget,
  replyTargetSchema,
} from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createSecretReader, findInstalledApp } from "./apps.ts";
import {
  createSlackClient,
  type SlackClient,
  type SlackFetch,
} from "./client.ts";
import { describeFailure, withRetry } from "./post.ts";

export interface SlackGatewayOptions {
  clock: Clock;
  db: Database;
  /** Runs work after the response (`waitUntil`). Without it, uploads are awaited. */
  defer?: (work: Promise<void>) => void;
  events: EventsService;
  fetch: SlackFetch;
  files: FilesService;
  /** `PUBLIC_BASE_URL`. A Connect path becomes a link under it. */
  publicBaseUrl?: string;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}

/** What is stored in `runs.pending_files` for each file of a Slack message. */
export const pendingFileSchema = z.strictObject({
  id: z.string().min(1),
  mimetype: z.string(),
  name: z.string(),
  size: z.number().int().min(0),
  teamId: z.string().min(1),
  url: z.string().min(1),
});
export type PendingFile = z.infer<typeof pendingFileSchema>;

/** Types the agent can read: text, images, PDF, JSON, Office files and zips. */
const ALLOWED_MIME_PREFIXES = [
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.",
  "application/zip",
  "image/",
  "text/",
];

export const isAllowedMime = (mime: string): boolean =>
  ALLOWED_MIME_PREFIXES.some((prefix) => mime.toLowerCase().startsWith(prefix));

/** A link to the signed-in Connect page, relative or absolute. */
const CONNECT_LINK = /(?:https?:\/\/[^\s/<>|]+)?\/connect\/[^\s<>|)\]]+/g;
const PRIVATE_NOTE = "(the link was sent to you privately)";
const EMPTY_REPLY = "(no reply)";
/**
 * How long a delivery may start new uploads. `waitUntil` gives the work 30 s
 * after the response, so a file not started by then is reported, not cut off.
 */
const UPLOAD_BUDGET_MS = 20_000;

/**
 * The first Connect link in the text that points at this app: a path, or a
 * URL under `publicBaseUrl`. A link to any other host is only text, so an
 * agent cannot use the private message to hand someone a phishing address.
 */
export const findConnectLink = (
  text: string,
  publicBaseUrl: string | undefined
): string | undefined => {
  const origin = publicBaseUrl ? new URL(publicBaseUrl).origin : undefined;
  return text
    .match(CONNECT_LINK)
    ?.find(
      (link) =>
        link.startsWith("/") || (origin && link.startsWith(`${origin}/`))
    );
};

const slackTarget = (
  target: ReplyTarget
): Extract<ReplyTarget, { kind: "slack" }> | null =>
  target.kind === "slack" ? target : null;

export type SlackGateway = Gateway & {
  /**
   * Tells the person a connector needs a login, in a private Slack message.
   * The composition root registers it with `events.onAppend`. It sends at most
   * one private message per run and connector, and it is best effort: it logs
   * a failure and never throws.
   */
  notifyNeedsAuth: (event: EventRecord) => Promise<void>;
};

export const createSlackGateway = ({
  clock,
  db,
  defer,
  events,
  fetch: slackFetch,
  files,
  publicBaseUrl,
  secretsKey,
}: SlackGatewayOptions): SlackGateway => {
  const secrets = createSecretReader(secretsKey);

  const clientFor = async (query: {
    agentId: string;
    teamId: string;
    workspaceId: string;
  }): Promise<SlackClient> => {
    const app = await findInstalledApp(db, query);
    const token = app ? await secrets.botToken(app) : null;
    if (!token) {
      throw new Error("The agent has no installed Slack app for this team");
    }
    return createSlackClient({ fetch: slackFetch, token });
  };

  const slackUserOf = async (
    workspaceId: string,
    teamId: string,
    clerkUserId: string
  ): Promise<string | null> => {
    const [link] = await db
      .select({ externalUserId: identityLinks.externalUserId })
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.workspaceId, workspaceId),
          eq(identityLinks.provider, "slack"),
          eq(identityLinks.teamId, teamId),
          eq(identityLinks.clerkUserId, clerkUserId)
        )
      )
      .limit(1);
    return link?.externalUserId ?? null;
  };

  /** The link goes only to the person the run is for, as a message nobody else sees. */
  const sendConnectLink = async (
    client: SlackClient,
    slack: Extract<ReplyTarget, { kind: "slack" }>,
    user: string,
    link: string
  ) => {
    const url = link.startsWith("/") ? `${publicBaseUrl ?? ""}${link}` : link;
    return await withRetry(clock, () =>
      client.postEphemeral({
        channel: slack.channel,
        text: `Connect your account: ${url}`,
        threadTs: slack.threadTs,
        user,
      })
    );
  };

  /**
   * Uploads one output file to the thread. A failure comes back as a
   * `name: reason` string, so one bad file does not stop the others.
   */
  const uploadOutput = async (
    client: SlackClient,
    slack: Extract<ReplyTarget, { kind: "slack" }>,
    principal: Extract<Principal, { kind: "run" }>,
    fileId: string
  ): Promise<string | null> => {
    let label = fileId;
    try {
      const { body, file } = await files.download(principal, fileId);
      label = file.name;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const uploaded = await withRetry(clock, () =>
        client.uploadFile({
          bytes,
          channel: slack.channel,
          filename: file.name,
          threadTs: slack.threadTs,
        })
      );
      return uploaded.kind === "ok"
        ? null
        : `${label}: ${describeFailure(uploaded)}`;
    } catch (error) {
      return `${label}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  /** Uploads the run's output files in order, one at a time, and returns the failures. */
  const uploadOutputs = async (
    client: SlackClient,
    slack: Extract<ReplyTarget, { kind: "slack" }>,
    fileIds: string[],
    run: { agentId: string; runId: string; workspaceId: string },
    deadline: number
  ): Promise<string[]> => {
    const principal = { ...run, kind: "run" } as const;
    const failures: string[] = [];
    for (const fileId of fileIds) {
      if (clock.now().getTime() >= deadline) {
        failures.push(`${fileId}: not uploaded, out of time`);
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      const failure = await uploadOutput(client, slack, principal, fileId);
      if (failure) {
        failures.push(failure);
      }
    }
    return failures;
  };

  /** Posts the answer, the Connect link it carries to its requester alone, then its files. */
  const post = async (
    slack: Extract<ReplyTarget, { kind: "slack" }>,
    message: { fileIds: string[]; text: string },
    context: DeliveryContext,
    workspaceId: string
  ): Promise<{ error?: string; ok: boolean }> => {
    const deadline = clock.now().getTime() + UPLOAD_BUDGET_MS;
    const client = await clientFor({
      agentId: context.agentId,
      teamId: slack.teamId,
      workspaceId,
    });
    // The agent's file markers are paths on its machine, not something to show.
    const text = stripAttachmentMarkers(message.text);
    const link = findConnectLink(text, publicBaseUrl);
    const requester =
      link && context.onBehalfOfUserId
        ? await slackUserOf(workspaceId, slack.teamId, context.onBehalfOfUserId)
        : null;
    // The link leaves the thread only when there is someone to send it to.
    const visible =
      link && requester ? text.replaceAll(link, PRIVATE_NOTE) : text;
    const posted = await withRetry(clock, () =>
      client.postMessage({
        channel: slack.channel,
        text: visible.trim() === "" ? EMPTY_REPLY : visible,
        threadTs: slack.threadTs,
      })
    );
    if (posted.kind !== "ok") {
      return { error: describeFailure(posted), ok: false };
    }
    const failures: string[] = [];
    if (link && requester) {
      const sent = await sendConnectLink(client, slack, requester, link);
      if (sent.kind !== "ok") {
        failures.push(`connect link: ${describeFailure(sent)}`);
      }
    }
    failures.push(
      ...(await uploadOutputs(
        client,
        slack,
        message.fileIds,
        {
          agentId: context.agentId,
          runId: context.runId,
          workspaceId,
        },
        deadline
      ))
    );
    return failures.length > 0
      ? { error: failures.join("; "), ok: true }
      : { ok: true };
  };

  const deliver: Gateway["deliver"] = async (target, message, context) => {
    const slack = slackTarget(target);
    if (!slack) {
      return;
    }
    const [run] = await db
      .select({ sessionId: runs.sessionId, workspaceId: runs.workspaceId })
      .from(runs)
      .where(eq(runs.id, context.runId))
      .limit(1);
    if (!run) {
      return;
    }
    const finish = async () => {
      let delivered: { error?: string; ok: boolean };
      try {
        delivered = await post(slack, message, context, run.workspaceId);
      } catch (error) {
        delivered = {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        };
      }
      // A Slack outage must not undo a finished run, so the outcome is an event.
      await events.append({
        actor: { id: "slack", kind: "system" },
        agentId: context.agentId,
        payload: {
          channel: slack.channel,
          delivered: delivered.ok,
          threadTs: slack.threadTs,
          ...(delivered.error ? { error: delivered.error } : {}),
        },
        runId: context.runId,
        sessionId: run.sessionId,
        type: "slack.delivered",
        workspaceId: run.workspaceId,
      });
    };
    // Uploads can take longer than the request that completed the run is
    // allowed to, so with files the whole delivery runs after the response.
    if (defer && message.fileIds.length > 0) {
      defer(
        finish().catch((error: unknown) => {
          console.error("Slack delivery failed", error);
        })
      );
      return;
    }
    await finish();
  };

  const downloadPendingFiles: NonNullable<
    Gateway["downloadPendingFiles"]
  > = async (descriptors, context) => {
    const pending = z.array(pendingFileSchema).parse(descriptors);
    const [first] = pending;
    if (!first) {
      return [];
    }
    if (!context.onBehalfOfUserId) {
      throw new Error("A Slack run has no user to own its files");
    }
    const client = await clientFor({
      agentId: context.agentId,
      teamId: first.teamId,
      workspaceId: context.workspaceId,
    });
    const owner = {
      kind: "user",
      userId: context.onBehalfOfUserId,
      via: "slack",
      workspaceId: context.workspaceId,
    } as const;
    const fileIds: string[] = [];
    for (const file of pending) {
      if (file.size > MAX_FILE_BYTES || !isAllowedMime(file.mimetype)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      const download = await client.downloadFile(file.url, MAX_FILE_BYTES);
      if (download.kind === "transient") {
        throw new Error(`Slack file download failed: ${download.error}`);
      }
      if (download.kind !== "ok") {
        continue;
      }
      const stored = await files.upload(owner, {
        body: new Blob([download.bytes], { type: file.mimetype }),
        mime: file.mimetype,
        name: file.name,
      });
      fileIds.push(stored.id);
    }
    return fileIds;
  };

  /** True when an earlier needs_auth event of the run already named this connector. */
  const noticeSentBefore = async (
    runId: string,
    eventId: string,
    connectorId: string
  ): Promise<boolean> => {
    const earlier = await db
      .select({ payload: eventRows.payload })
      .from(eventRows)
      .where(
        and(
          eq(eventRows.runId, runId),
          eq(eventRows.type, "connector.needs_auth"),
          lt(eventRows.id, eventId)
        )
      );
    return earlier.some((row) => {
      const parsed = payloadSchema.safeParse(JSON.parse(row.payload ?? "{}"));
      return parsed.success && parsed.data.connectorId === connectorId;
    });
  };

  /** The owner of a user login, otherwise the person the run is for. */
  const connectingUserOf = (
    payload: Payload,
    onBehalfOfUserId: string | null
  ): string | null => {
    const { ownerId, ownerKind } = payload;
    return ownerKind === "user" && typeof ownerId === "string"
      ? ownerId
      : onBehalfOfUserId;
  };

  const notifyNeedsAuth: SlackGateway["notifyNeedsAuth"] = async (event) => {
    try {
      const { connectPath, connectorId } = event.payload;
      if (
        event.type !== "connector.needs_auth" ||
        !event.runId ||
        typeof connectPath !== "string" ||
        connectPath === "" ||
        typeof connectorId !== "string"
      ) {
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
        .where(eq(runs.id, event.runId))
        .limit(1);
      if (!run) {
        return;
      }
      const slack =
        run.reply === null
          ? null
          : slackTarget(replyTargetSchema.parse(JSON.parse(run.reply)));
      if (!slack) {
        return;
      }
      if (await noticeSentBefore(event.runId, event.id, connectorId)) {
        return;
      }
      const clerkUserId = connectingUserOf(event.payload, run.onBehalfOfUserId);
      if (!clerkUserId) {
        return;
      }
      const slackUserId = await slackUserOf(
        run.workspaceId,
        slack.teamId,
        clerkUserId
      );
      if (!slackUserId) {
        return;
      }
      const client = await clientFor({
        agentId: run.agentId,
        teamId: slack.teamId,
        workspaceId: run.workspaceId,
      });
      const sent = await sendConnectLink(
        client,
        slack,
        slackUserId,
        connectPath
      );
      if (sent.kind !== "ok") {
        console.warn("Slack needs-auth notice not sent", describeFailure(sent));
      }
    } catch (error) {
      console.error("Slack needs-auth notice failed", error);
    }
  };

  return { deliver, downloadPendingFiles, kind: "slack", notifyNeedsAuth };
};
