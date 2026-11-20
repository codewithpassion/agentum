#!/usr/bin/env bun
// A fake Slack for a local walkthrough of the Slack link. It answers Slack's Web
// API for the three apps in `fake-slack-config.ts`, and shows the channel as a
// web page where a person can write, reply in a thread, press a card's buttons
// and invite or remove an app. Each message is delivered, signed, to every app
// in the channel, the way Slack does. The dev app reaches the fake when it runs
// with `VITE_FAKE_SLACK_URL=http://localhost:<port>` (see
// apps/web/src/server/dev-slack-fetch.ts). Run from the repo root:
// `bun scripts/dev/fake-slack.ts --app-url http://localhost:<app port> [--port 5199]`.
import { parseArgs } from "node:util";
import {
  createFakeSlack,
  type Delivery,
  type FakeMessage,
} from "@repo/services/slack/fake-slack";
import { serve } from "bun";
import {
  CHANNEL_ID,
  CHANNEL_NAME,
  DEV_SLACK_USER,
  fakeSlackConfig,
  GUEST_SLACK_USER,
} from "./fake-slack-config.ts";
import { LocalError, runCli } from "./local.ts";

const DEFAULT_PORT = 5199;
const OK = 200;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const PAGE_POLL_MS = 1000;
const TRAILING_SLASHES = /\/+$/;

interface BlockView {
  buttons: { actionId: string; label: string }[];
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textField = (value: unknown): string =>
  isRecord(value) && typeof value.text === "string" ? value.text : "";

/** What a message's blocks show: their text, and the buttons of an actions block. */
const viewOfBlocks = (blocks: unknown[] | null): BlockView => {
  const view: BlockView = { buttons: [], text: "" };
  for (const block of blocks ?? []) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "actions" && Array.isArray(block.elements)) {
      for (const element of block.elements) {
        if (isRecord(element) && typeof element.action_id === "string") {
          view.buttons.push({
            actionId: element.action_id,
            label: textField(element.text),
          });
        }
      }
    } else {
      const text = textField(block.text);
      view.text += text === "" ? "" : `${text}\n`;
    }
  }
  return view;
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake Slack</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 0; background: #f8f8f8; color: #1d1c1d; }
  header { background: #3f0e40; color: #fff; padding: 10px 16px; font-weight: 600; }
  main { max-width: 760px; margin: 0 auto; padding: 12px 16px 120px; }
  .msg { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; margin: 8px 0; }
  .msg.reply { margin-left: 28px; }
  .who { font-weight: 700; }
  .who small { font-weight: 400; color: #616061; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .detail { white-space: pre-wrap; color: #444; margin-top: 4px; }
  button { font: inherit; padding: 4px 10px; margin: 4px 6px 0 0; }
  form { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; border-top: 1px solid #ccc; padding: 10px 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  form input[type=text] { flex: 1 1 200px; font: inherit; padding: 6px; }
  .apps { margin: 8px 0; }
</style>
</head>
<body>
<header>Fake Slack - #${CHANNEL_NAME}</header>
<main>
  <div class="apps" id="apps"></div>
  <div id="messages"></div>
  <div id="ephemerals"></div>
</main>
<form id="say">
  <select id="who" aria-label="Write as"></select>
  <select id="thread" aria-label="Reply in thread"><option value="">New message</option></select>
  <input id="text" type="text" aria-label="Message" placeholder="Message #${CHANNEL_NAME}" autocomplete="off">
  <button type="submit">Send</button>
</form>
<script>
const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
let state = null;
async function refresh() {
  const response = await fetch("/_state");
  state = await response.json();
  const who = document.getElementById("who");
  if (!who.options.length) {
    for (const user of state.users) { const o = el("option", "", user.name); o.value = user.id; who.append(o); }
  }
  const apps = document.getElementById("apps");
  apps.replaceChildren(el("strong", "", "Apps: "));
  for (const app of state.apps) {
    const label = el("span", "", app.name + (app.inChannel ? " (in channel) " : " (not in channel) "));
    const toggle = el("button", "", app.inChannel ? "Remove " + app.name : "Invite " + app.name);
    toggle.onclick = async () => { await post("/_membership", { botUserId: app.botUserId, member: !app.inChannel }); refresh(); };
    apps.append(label, toggle);
  }
  const threads = document.getElementById("thread");
  const chosen = threads.value;
  threads.replaceChildren(Object.assign(el("option", "", "New message"), { value: "" }));
  for (const root of state.messages.filter((m) => !m.threadTs || m.threadTs === m.ts)) {
    const o = el("option", "", "Reply to: " + root.text.slice(0, 40)); o.value = root.ts; threads.append(o);
  }
  threads.value = chosen;
  const messages = document.getElementById("messages");
  messages.replaceChildren();
  for (const message of state.messages) {
    const reply = message.threadTs && message.threadTs !== message.ts;
    const box = el("div", "msg" + (reply ? " reply" : ""));
    box.dataset.ts = message.ts;
    const who = el("div", "who", message.author);
    who.append(el("small", "", " " + message.ts + (reply ? " (thread " + message.threadTs + ")" : "")));
    box.append(who, el("div", "text", message.text));
    if (message.detail) box.append(el("div", "detail", message.detail));
    for (const button of message.buttons) {
      const b = el("button", "", button.label || button.actionId);
      b.onclick = async () => { await post("/_click", { actionId: button.actionId, ts: message.ts, user: document.getElementById("who").value }); refresh(); };
      box.append(b);
    }
    messages.append(box);
  }
  const ephemerals = document.getElementById("ephemerals");
  ephemerals.replaceChildren();
  for (const item of state.ephemerals) ephemerals.append(el("div", "msg", "Only visible to " + item.user + ": " + item.text));
}
document.getElementById("say").onsubmit = async (event) => {
  event.preventDefault();
  const input = document.getElementById("text");
  if (!input.value.trim()) return;
  await post("/_say", { text: input.value, threadTs: document.getElementById("thread").value || undefined, user: document.getElementById("who").value });
  input.value = "";
  refresh();
};
refresh();
setInterval(refresh, ${PAGE_POLL_MS});
</script>
</body>
</html>`;

const json = (body: unknown, status = OK): Response =>
  Response.json(body, { status });

type Fake = ReturnType<typeof createFakeSlack>;
type Config = ReturnType<typeof fakeSlackConfig>;

/** The page's view of the fake: apps, messages and what only one person sees. */
const stateOf = (fake: Fake, config: Config) => {
  const channel = config.channels.find((entry) => entry.id === CHANNEL_ID);
  const authorOf = (message: FakeMessage): string =>
    config.users.find((user) => user.id === message.user)?.name ??
    config.apps.find((app) => app.appId === message.appId)?.name ??
    message.user;
  return {
    apps: config.apps.map((app) => ({
      botUserId: app.botUserId,
      inChannel: channel?.members.includes(app.botUserId) ?? false,
      name: app.name,
    })),
    deliveryErrors: fake.deliveryErrors,
    ephemerals: fake.ephemerals,
    messages: fake.messages.map((message) => {
      const view = viewOfBlocks(message.blocks);
      return {
        author: authorOf(message),
        buttons: view.buttons,
        detail: view.text.trim(),
        text: message.text,
        threadTs: message.threadTs,
        ts: message.ts,
      };
    }),
    users: config.users,
  };
};

/** A person writes, presses a button, or an app joins or leaves the channel. */
const control = (
  fake: Fake,
  config: Config,
  path: string,
  input: Record<string, unknown>
): Response => {
  const user = String(input.user ?? DEV_SLACK_USER);
  if (path === "/_say") {
    const message = fake.say({
      channel: CHANNEL_ID,
      text: String(input.text ?? ""),
      threadTs: typeof input.threadTs === "string" ? input.threadTs : undefined,
      user,
    });
    return json({ ts: message.ts });
  }
  if (path === "/_click") {
    fake.click({
      actionId: String(input.actionId),
      channel: CHANNEL_ID,
      ts: String(input.ts),
      user,
    });
    return json({ ok: true });
  }
  const channel = config.channels.find((entry) => entry.id === CHANNEL_ID);
  if (path === "/_membership" && channel) {
    const botUserId = String(input.botUserId);
    channel.members = channel.members.filter((member) => member !== botUserId);
    if (input.member === true) {
      channel.members.push(botUserId);
    }
    return json({ ok: true });
  }
  return json({ error: "not found" }, NOT_FOUND);
};

/** Posts a signed delivery to the app's route and fails on any answer but 200. */
const deliverTo =
  (origin: string) =>
  async (delivery: Delivery): Promise<void> => {
    const isEvent = delivery.kind === "events";
    const response = await fetch(
      `${origin}/api/slack/${isEvent ? "events" : "interactions"}`,
      {
        body: delivery.rawBody,
        headers: {
          "Content-Type": isEvent
            ? "application/json"
            : "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": delivery.timestamp,
          "X-Slack-Signature": delivery.signature,
        },
        method: "POST",
      }
    );
    if (response.status !== OK) {
      throw new Error(`The app answered ${response.status} to a delivery.`);
    }
  };

export const main = (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      "app-url": { type: "string" },
      port: { type: "string" },
    },
  });
  const appUrl = values["app-url"];
  if (!appUrl) {
    throw new LocalError(
      "Pass --app-url, the origin of the dev app, for example http://localhost:5190."
    );
  }
  const origin = appUrl.replace(TRAILING_SLASHES, "");
  const config = fakeSlackConfig();
  const fake = createFakeSlack({ config, deliver: deliverTo(origin) });

  const server = serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const body = await request.text();
        return fake.fetch(url.href, {
          body: body === "" ? undefined : body,
          headers: request.headers,
          method: request.method,
        });
      }
      if (request.method === "GET") {
        return url.pathname === "/_state"
          ? json(stateOf(fake, config))
          : new Response(PAGE, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
      }
      const input: unknown = await request.json();
      return isRecord(input)
        ? control(fake, config, url.pathname, input)
        : json({ error: "send a JSON object" }, BAD_REQUEST);
    },
    port: Number(values.port ?? DEFAULT_PORT),
  });
  process.stderr.write(
    `Fake Slack on http://localhost:${server.port}, delivering to ${origin}. Guest user: ${GUEST_SLACK_USER}.\n`
  );
  return Promise.resolve();
};

if (import.meta.main) {
  runCli(main);
}
