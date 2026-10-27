// biome-ignore-all lint/suspicious/noMisplacedAssertion: this executable is a standalone integration check.

import { strict as assert } from "node:assert/strict";
import { $, file } from "bun";
import { chromium } from "playwright";

await $`bun build browser-client.ts --target browser --outfile .browser.js`.quiet();
const bundle = await file(".browser.js").text();
const browser = await chromium.launch({ headless: true });
const contexts = await Promise.all([
  browser.newContext(),
  browser.newContext(),
]);
const pages = await Promise.all(
  contexts.map(async (context) => {
    const page = await context.newPage();
    await page.route("http://fixture.test/", (route) =>
      route.fulfill({
        body: `<script>${bundle}</script>`,
        contentType: "text/html",
      })
    );
    await page.goto("http://fixture.test/");
    return page;
  })
);
const api = (page: (typeof pages)[number], expression: string) =>
  page.evaluate(expression);
const wait = (page: (typeof pages)[number], expression: string) =>
  page.waitForFunction(expression, null, { timeout: 10_000 });
const ids = await Promise.all(pages.map((p) => api(p, "window.clientId")));
const claims = (i: number, extra = {}) => ({
  artifact: "test",
  clientId: ids[i],
  color: i ? "blue" : "red",
  exp: Date.now() + 120_000,
  kind: "human",
  name: `Person ${i}`,
  participant: `participant${i}`,
  role: "edit",
  ...extra,
});
const ticket = async (body: object) =>
  (
    await (
      await fetch("http://localhost:18987/ticket", {
        body: JSON.stringify(body),
        method: "POST",
      })
    ).json()
  ).ticket;
const upgrade = (token: string, room = "test") =>
  fetch(
    `http://localhost:18987/parties/live/${room}?ticket=${encodeURIComponent(token)}`,
    { headers: { Upgrade: "websocket" } }
  );
try {
  const tickets = await Promise.all(ids.map((_, i) => ticket(claims(i))));
  await Promise.all(
    pages.map((p, i) => api(p, `window.connect(${JSON.stringify(tickets[i])})`))
  );
  await Promise.all(pages.map((p) => wait(p, "window.connected()")));
  await api(pages[0], `window.insert('hello')`);
  await wait(pages[1], `window.text() === 'hello'`);
  await api(pages[0], `window.identity('Forged')`);
  await wait(
    pages[1],
    `window.states().some(([id,s]) => id === ${ids[0]} && s.user?.name === 'Person 0' && s.user?.kind === 'human' && s.user?.color === 'red')`
  );
  await api(pages[0], `window.forge(${ids[1]})`);
  await new Promise((r) => setTimeout(r, 500));
  assert(
    !(await api(
      pages[1],
      `window.states().some(([id,s]) => id === ${ids[1]} && s.user?.name === 'Forged other')`
    ))
  );
  await fetch("http://localhost:18987/agent");
  await Promise.all(
    pages.map((p) =>
      wait(p, `window.states().some(([id,s]) => s.user?.name === 'Agent')`)
    )
  );
  const before = await (await fetch("http://localhost:18987/stats")).json();
  await new Promise((r) => setTimeout(r, 15_000));
  const after = await (await fetch("http://localhost:18987/stats")).json();
  assert(after.starts > before.starts);
  assert.equal(after.sockets, 2);
  await api(pages[0], `window.forge(${ids[1]})`);
  await new Promise((r) => setTimeout(r, 500));
  assert(
    !(await api(
      pages[1],
      `window.states().some(([id,s]) => id === ${ids[1]} && s.user?.name === 'Forged other')`
    ))
  );
  await api(pages[1], `window.insert('!')`);
  await wait(pages[0], `window.text() === '!hello'`);
  assert.equal((await upgrade(tickets[0])).status, 403);
  assert.equal(
    (await upgrade(await ticket(claims(0, { clientId: 12_345 })), "other"))
      .status,
    403
  );
  assert.equal(
    (
      await upgrade(
        await ticket(claims(0, { clientId: 12_346, exp: Date.now() - 1 }))
      )
    ).status,
    403
  );
  const readContext = await browser.newContext();
  const reader = await readContext.newPage();
  await reader.route("http://fixture.test/", (route) =>
    route.fulfill({
      body: `<script>${bundle}</script>`,
      contentType: "text/html",
    })
  );
  await reader.goto("http://fixture.test/");
  const readerId = await api(reader, "window.clientId");
  const readTicket = await ticket(
    claims(0, { clientId: readerId, participant: "reader", role: "read" })
  );
  await api(reader, `window.connect(${JSON.stringify(readTicket)})`);
  await wait(reader, "window.connected()");
  await wait(reader, `window.text() === '!hello'`);
  await api(reader, `window.insert('ILLEGAL')`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await api(pages[1], "window.text()"), "!hello");
  assert.equal((await upgrade(`${tickets[0]}x`)).status, 403);
  const revoke = await (
    await fetch("http://localhost:18987/revoke?id=participant0")
  ).json();
  assert.equal(revoke, 1);
  await wait(pages[0], "!window.connected()");
  assert(await api(pages[1], "window.connected()"));
  console.log(
    JSON.stringify({
      after,
      agent: true,
      artifactMismatch: 403,
      before,
      browserContexts: 2,
      crossIdRejected: true,
      expired: 403,
      identitySanitized: true,
      postIdleConvergence: true,
      readOnlyRejected: true,
      replay: 403,
      revoke,
      tampered: 403,
    })
  );
} finally {
  await browser.close();
  await file(".browser.js").delete();
}
