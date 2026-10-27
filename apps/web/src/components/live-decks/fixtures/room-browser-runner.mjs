/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Network proxy callbacks observe state changed by later browser actions. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Ordered real network browser acceptance. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let input = "";
for await (const part of process.stdin) {
  input += part;
}
const { script, output, slides, structural = true } = JSON.parse(input);
const persistence = await mkdtemp(join(tmpdir(), "ld6-room-network-"));
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    compatibilityDate: "2026-08-19",
    durableObjects: {
      ROOM: { className: "TestArtifactRoom", useSQLite: true },
    },
    modules: true,
    resourcePersistencePath: persistence,
    script,
  })
);
const evidence = await mkdtemp(join(tmpdir(), "ld6-browser-evidence-"));
const browser = await chromium.launch({ headless: true });
try {
  const base = new URL(await runtime.ready).origin;
  for (const viewport of [
    { height: 800, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    const room = `deck-${viewport.width}`;
    const call = async (path, body = {}) => {
      const response = await runtime.dispatchFetch(
        `${base}${path}?room=${room}`,
        { body: JSON.stringify(body), method: "POST" }
      );
      if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${await response.text()}`);
      }
      return response.json();
    };
    await call("/control", { name: "deck", value: true });
    await call("/control", { name: "urls", value: [] });
    await call("/control", {
      name: "slides",
      value: slides,
    });
    const initialSnapshot = await call("/snapshot");
    const pair = await Promise.all([
      browser.newContext({
        hasTouch: viewport.width === 390,
        isMobile: viewport.width === 390,
        permissions: ["local-network-access"],
        viewport,
      }),
      browser.newContext({
        hasTouch: viewport.width === 390,
        isMobile: viewport.width === 390,
        permissions: ["local-network-access"],
        viewport,
      }),
    ]);
    const pages = await Promise.all(pair.map((context) => context.newPage()));
    const errors = [];
    let holdPresentation = false;
    const delayed = [];
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (event) => {
        if (event.type() === "error") {
          console.error(
            event.text().replace(/ticket=[^&\s]+/g, "ticket=REDACTED")
          );
        }
      });
      if (index === 0) {
        await page.routeWebSocket("**/socket?**", (ws) => {
          const server = ws.connectToServer();
          server.onMessage((message) => {
            if (
              holdPresentation &&
              typeof message === "string" &&
              JSON.parse(message).type === "presentation-result"
            ) {
              delayed.push(() => ws.send(message));
            } else {
              ws.send(message);
            }
          });
        });
      }
      await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path !== "/" && !path.startsWith("/assets/")) {
          await route.continue();
          return;
        }
        const filename = path === "/" ? "index.html" : path.slice(1);
        await route.fulfill({
          body: await readFile(join(output, filename)),
          contentType:
            {
              ".css": "text/css",
              ".html": "text/html",
              ".js": "text/javascript",
            }[extname(filename)] ?? "application/octet-stream",
        });
      });
      await page.goto(
        `${base}/?room=${room}&participant=${index === 0 ? "alice" : "bob"}`
      );
      await expect(
        page.getByRole("region", { name: "Live deck editor" })
      ).toBeVisible();
    }
    const [alice, bob] = pages;
    const scene = (page) =>
      page.evaluate(
        () => Reflect.get(window, "deckRoom").deck.read("opening").slide
      );
    await expect
      .poll(async () =>
        alice.evaluate(
          () => Reflect.get(window, "deckRoom").participants.length
        )
      )
      .toBe(2);
    await Promise.all([
      alice.evaluate(() =>
        Reflect.get(window, "deckRoom").deck.setElementKey(
          "opening",
          "box",
          "style",
          "background-color",
          "#ff0000"
        )
      ),
      bob.evaluate(() =>
        Reflect.get(window, "deckRoom").deck.setElementKey(
          "opening",
          "box",
          "props",
          "x",
          "520"
        )
      ),
    ]);
    for (const page of pages) {
      await expect
        .poll(
          async () =>
            (await scene(page)).elements.find((element) => element.id === "box")
              .style["background-color"]
        )
        .toBe("#ff0000");
      await expect
        .poll(
          async () =>
            (await scene(page)).elements.find((element) => element.id === "box")
              .props.x
        )
        .toBe("520");
    }
    await Promise.all(
      pages.map((page) =>
        page.locator('.ld-stage .tiptap[contenteditable="true"]').press("End")
      )
    );
    await Promise.all([
      alice
        .locator('.ld-stage .tiptap[contenteditable="true"]')
        .pressSequentially(" Alice"),
      bob
        .locator('.ld-stage .tiptap[contenteditable="true"]')
        .pressSequentially(" Bob"),
    ]);
    for (const page of pages) {
      await expect
        .poll(async () => JSON.stringify(await scene(page)))
        .toContain("Alice");
      await expect
        .poll(async () => JSON.stringify(await scene(page)))
        .toContain("Bob");
    }
    await alice.getByRole("button", { exact: true, name: "Undo text" }).click();
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .not.toContain("Alice");
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .toContain("Bob");
    await alice.getByRole("button", { exact: true, name: "Redo text" }).click();
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .toContain("Alice");
    await alice.getByRole("button", { exact: true, name: "Undo text" }).click();
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .not.toContain("Alice");
    if (structural) {
      await alice
        .getByRole("button", { exact: true, name: "Bullet list" })
        .click();
      await expect
        .poll(async () => JSON.stringify(await scene(bob)))
        .toContain('"tag":"ul"');
      await alice
        .locator('.ld-stage [data-element-id="headline"] .tiptap')
        .press("End");
      await alice
        .locator('.ld-stage [data-element-id="headline"] .tiptap')
        .press("Enter");
      await alice
        .locator('.ld-stage [data-element-id="headline"] .tiptap')
        .pressSequentially("Split paragraph");
      await expect
        .poll(async () => JSON.stringify(await scene(bob)))
        .toContain("Split paragraph");
    }
    await Promise.all(
      pages.map((page) =>
        page
          .getByRole("button", { exact: true, name: "Edit table cell 0:0" })
          .click()
      )
    );
    for (const page of pages) {
      await expect(
        page.locator('.ld-stage [data-element-id="table"] .tiptap')
      ).toBeVisible();
    }
    const fragmentIds = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const connected = Reflect.get(window, "deckRoom");
          return connected.deck.cellFragment("opening", "table", "0:0")._item
            .id;
        })
      )
    );
    expect(fragmentIds[0]).toEqual(fragmentIds[1]);
    console.log(
      `Shared empty cell ${viewport.width}: ${JSON.stringify(fragmentIds)}`
    );
    const cell = (page) =>
      page.locator('.ld-stage [data-element-id="table"] .tiptap');
    await Promise.all([
      cell(alice).pressSequentially("Cell Alice"),
      cell(bob).pressSequentially("Cell Bob"),
    ]);
    for (const page of pages) {
      await expect
        .poll(async () => JSON.stringify(await scene(page)))
        .toContain("Cell Alice");
      await expect
        .poll(async () => JSON.stringify(await scene(page)))
        .toContain("Cell Bob");
    }
    await alice.getByRole("button", { exact: true, name: "Undo text" }).click();
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .not.toContain("Cell Alice");
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .toContain("Cell Bob");
    await alice.getByRole("button", { exact: true, name: "Redo text" }).click();
    await expect
      .poll(async () => JSON.stringify(await scene(bob)))
      .toContain("Cell Alice");
    if (structural) {
      await alice
        .getByRole("button", { exact: true, name: "Bullet list" })
        .click();
      await expect
        .poll(async () =>
          JSON.stringify(
            (await scene(bob)).elements.find(
              (element) => element.id === "table"
            ).cells
          )
        )
        .toContain('"tag":"ul"');
    }
    for (const page of pages) {
      expect(
        await page.evaluate(() => [
          ...Reflect.get(window, "deckRoom").document.share.keys(),
        ])
      ).toEqual(expect.arrayContaining(["meta", "slides"]));
    }
    await Promise.all(
      pages.map((page) =>
        page.getByRole("button", { exact: true, name: "Add slide" }).click()
      )
    );
    await expect
      .poll(() =>
        alice.evaluate(() => Reflect.get(window, "deckRoom").deck.ids().length)
      )
      .toBe(4);
    await expect
      .poll(() =>
        bob.evaluate(() => Reflect.get(window, "deckRoom").deck.ids().length)
      )
      .toBe(4);
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom").confirmLocation({
        elementIds: ["headline", "box"],
        slideId: "opening",
        slideNumber: 1,
      })
    );
    const trustedPresence = await call("/presence");
    expect(
      trustedPresence.find((person) => person.id === "alice").selection
    ).toEqual(["headline", "box"]);
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom").publishPresence({
        pointer: { x: 120, y: 140 },
        selection: ["box"],
        slideId: "opening",
      })
    );
    await expect
      .poll(() =>
        bob.evaluate(
          () =>
            Reflect.get(window, "deckRoom").participants.find(
              (person) => person.id === "alice"
            )?.pointer?.x
        )
      )
      .toBe(120);
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom").presentToEveryone({
        build: 0,
        slideId: "closing",
      })
    );
    await expect
      .poll(() =>
        bob.evaluate(
          () => Reflect.get(window, "deckRoom").presentation?.slideId
        )
      )
      .toBe("closing");
    await expect(
      bob.getByRole("button", { exact: true, name: "Leave presenter" })
    ).toBeVisible();
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom").presentToEveryone({
        build: 1,
        slideId: "opening",
      })
    );
    await expect
      .poll(() =>
        bob.evaluate(() => Reflect.get(window, "deckRoom").presentation?.build)
      )
      .toBe(1);
    await bob
      .getByRole("button", { exact: true, name: "Leave presenter" })
      .click();
    await expect(
      bob.getByRole("button", { exact: true, name: "Follow presenter" })
    ).toBeVisible();
    await bob
      .getByRole("button", { exact: true, name: "Follow presenter" })
      .click();
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom").presentToEveryone(null)
    );
    await expect
      .poll(() =>
        bob.evaluate(() => Reflect.get(window, "deckRoom").presentation)
      )
      .toBeNull();
    await call("/checkpoint");
    await alice.reload();
    await expect(
      alice.getByRole("region", { name: "Live deck editor" })
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await scene(alice)).elements.find((element) => element.id === "box")
            .props.x
      )
      .toBe("520");
    await call("/deck-restore", {
      requestId: crypto.randomUUID(),
      state: initialSnapshot.state,
    });
    for (const page of pages) {
      await expect
        .poll(
          async () =>
            (await scene(page)).elements.find((element) => element.id === "box")
              .props.x
        )
        .toBe("480");
    }
    await alice.evaluate(() =>
      Reflect.get(window, "deckRoom")
        .document.getMap("optimistic_invalid")
        .set("payload", "must never reach authority")
    );
    await expect(alice.getByRole("alert")).toContainText("unknown root");
    await alice.getByRole("button", { name: "Reconnect fixture" }).click();
    await expect(
      alice.getByRole("region", { name: "Live deck editor" })
    ).toBeVisible();
    expect(
      await alice.evaluate(() =>
        Reflect.get(window, "deckRoom").document.share.has("optimistic_invalid")
      )
    ).toBe(false);
    expect(JSON.stringify(await call("/deck-read"))).not.toContain(
      "must never reach authority"
    );
    holdPresentation = true;
    await alice.getByRole("button", { exact: true, name: "Present" }).click();
    await alice
      .getByRole("button", { exact: true, name: "Present to everyone" })
      .click();
    await expect
      .poll(() =>
        bob.evaluate(
          () => Reflect.get(window, "deckRoom").presentation?.slideId
        )
      )
      .toBe("opening");
    await expect.poll(() => delayed.length).toBe(1);
    await call("/control", { name: "role:alice", value: "viewer" });
    await call("/refresh", { id: "alice" });
    await expect(alice.getByRole("alert")).toContainText(
      /permissions|disconnected/
    );
    await expect
      .poll(() =>
        bob.evaluate(() => Reflect.get(window, "deckRoom").presentation)
      )
      .toBeNull();
    holdPresentation = false;
    for (const deliver of delayed.splice(0)) {
      try {
        deliver();
      } catch {
        /* Revoked socket is already closed. */
      }
    }
    await alice.getByRole("button", { name: "Reconnect fixture" }).click();
    await expect(
      alice.getByRole("region", { name: "Live deck editor" })
    ).toBeVisible();
    await expect(
      alice.getByRole("button", { exact: true, name: "Add slide" })
    ).toBeDisabled();
    await alice.screenshot({
      fullPage: true,
      path: join(evidence, `deck-${viewport.width}.png`),
    });
    expect(errors).toEqual([]);
    console.log(
      `LD.6 actual workerd two-browser ${viewport.width}x${viewport.height} structural=${structural}: passed`
    );
    for (const context of pair) {
      await context.close();
    }
  }
} catch (cause) {
  let index = 0;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const dump = await page
        .evaluate(() => Reflect.get(window, "deckDump")?.())
        .catch(() => null);
      if (dump) {
        const path = join(evidence, `failed-scene-${index}.json`);
        await writeFile(path, JSON.stringify(dump));
        console.error(`Failed scene: ${path}`);
      }
      await page
        .screenshot({
          fullPage: true,
          path: join(evidence, `failed-${index}.png`),
        })
        .catch(() => undefined);
      index += 1;
    }
  }
  throw cause;
} finally {
  console.log(`Screenshots: ${evidence}`);
  await browser.close();
  await runtime.dispose();
  await rm(persistence, { force: true, recursive: true });
}
