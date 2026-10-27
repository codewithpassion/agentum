/** biome-ignore-all lint/performance/noAwaitInLoops: Each mounted action must be accepted by authority before the next case. */
import { expect } from "@playwright/test";

/** Arrange through the room's production codec; mutate only mounted controls.
 * JSON assertions inspect the independent peer, never the optimistic writer. */
export async function documentActionMatrix({ alice, bob, call }) {
  const json = () =>
    bob.evaluate(() => Reflect.get(window, "roomFixtureEditor").getJSON());
  const select = () =>
    alice.evaluate(() => {
      const editor = Reflect.get(window, "roomFixtureEditor");
      editor.commands.setTextSelection({
        from: 1,
        to: editor.state.doc.firstChild.nodeSize - 1,
      });
    });
  const seed = async () => {
    await call("/seed", { markdown: "Action sample.\n\nSecond block." });
    await expect(bob.locator(".tiptap")).toContainText("Action sample.");
    await expect(alice.locator(".tiptap")).toContainText("Action sample.");
    await select();
  };
  const group = async (name) => {
    await alice.locator("details.live-tools-group").evaluateAll((nodes) => {
      for (const node of nodes) {
        node.open = false;
      }
    });
    await alice
      .locator("details.live-tools-group")
      .filter({
        has: alice.locator("summary", { hasText: new RegExp(`^${name}$`) }),
      })
      .locator("summary")
      .click();
  };
  const button = (name) => alice.getByRole("button", { exact: true, name });
  const contains = async (value) =>
    expect.poll(async () => JSON.stringify(await json())).toContain(value);
  for (const [name, mark] of [
    ["Bold", "bold"],
    ["Italic", "italic"],
    ["Underline", "underline"],
    ["Strikethrough", "strike"],
    ["Inline code", "code"],
  ]) {
    await seed();
    await group("Text");
    await button(name).click();
    await contains(`"type":"${mark}"`);
    await button(name).click();
    await expect
      .poll(async () => JSON.stringify(await json()))
      .not.toContain(`"type":"${mark}"`);
  }
  await seed();
  await group("Text");
  await alice
    .getByRole("textbox", { exact: true, name: "Link URL" })
    .fill("https://example.test/reference");
  await button("Apply link").click();
  await contains('"href":"https://example.test/reference"');
  await button("Remove link").click();
  await expect
    .poll(async () => JSON.stringify(await json()))
    .not.toContain('"type":"link"');
  for (const color of await alice
    .getByRole("group", { exact: true, name: "Text colour" })
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.getAttribute("aria-label").replace("Text colour ", "")
      )
    )) {
    await select();
    await button(`Text colour ${color}`).click();
    await contains(`"color":"${color}"`);
  }
  await button("Bold").click();
  await button("Clear formatting").click();
  await expect
    .poll(async () => (await json()).content[0].content[0].marks ?? [])
    .toEqual([]);
  for (const [name, value] of [
    ["UPPER CASE", "ACTION SAMPLE."],
    ["lower case", "action sample."],
    ["Title Case", "Action Sample."],
    ["Sentence case", "Action sample."],
  ]) {
    await seed();
    await group("Case");
    await button(name).click();
    await contains(`"text":"${value}"`);
  }
  const blocks = [
    ["Paragraph", "paragraph"],
    ["Heading 1", "heading", 1],
    ["Heading 2", "heading", 2],
    ["Heading 3", "heading", 3],
    ["Bullet list", "bulletList"],
    ["Numbered list", "orderedList"],
    ["Checklist", "taskList"],
    ["Quote", "blockquote"],
    ["Code block", "codeBlock"],
    ["Divider", "horizontalRule"],
    ["Table", "table"],
  ];
  for (const [name, type, level] of blocks) {
    await seed();
    await group("Blocks");
    await button(name).click();
    await contains(`"type":"${type}"`);
    if (level) {
      await contains(`"level":${level}`);
    }
    await seed();
    await alice.evaluate(() =>
      Reflect.get(window, "roomFixtureEditor").commands.setTextSelection(1)
    );
    await alice.locator(".tiptap").pressSequentially("/");
    await alice
      .getByRole("group", { exact: true, name: "Insert block" })
      .getByRole("button", { exact: true, name })
      .click();
    await contains(`"type":"${type}"`);
  }
  await seed();
  await group("Table");
  await button("Insert table").click();
  const table = async () =>
    (await json()).content.find((node) => node.type === "table");
  await expect.poll(async () => (await table())?.content.length).toBe(3);
  const cell = async () => {
    await alice.locator(".tiptap th, .tiptap td").first().click();
  };
  for (const [name, rows, cols] of [
    ["Add row above", 4, 3],
    ["Add row below", 5, 3],
    ["Remove row", 4, 3],
    ["Add column before", 4, 4],
    ["Add column after", 4, 5],
    ["Remove column", 4, 4],
  ]) {
    await cell();
    await button(name).click();
    await expect
      .poll(async () => [
        (await table()).content.length,
        (await table()).content[0].content.length,
      ])
      .toEqual([rows, cols]);
  }
  await cell();
  await button("Header row").click();
  await expect
    .poll(async () => (await table()).content[0].content[0].type)
    .toBe("tableCell");
  for (const label of await alice
    .getByRole("group", { exact: true, name: "Cell colour" })
    .getByRole("button")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label"))
    )) {
    await cell();
    await button(label).click();
    await contains(`"backgroundColor":"${label.replace("Cell colour ", "")}"`);
  }
  await button("Remove table").click();
  await expect
    .poll(async () => JSON.stringify(await json()))
    .not.toContain('"type":"table"');
  await seed();
  await group("Insert");
  await alice
    .getByLabel("Mention a person", { exact: true })
    .selectOption("bob");
  await contains('"value":"bob"');
  await alice.getByLabel("Date chip", { exact: true }).fill("2026-10-28");
  await button("Insert date").click();
  await contains('"value":"2026-10-28"');
  await seed();
  const handle = alice
    .getByRole("button", { exact: true, name: "Drag paragraph block" })
    .first();
  const target = alice.locator(".tiptap p").last();
  await handle.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (alice.viewportSize().width === 1280) {
    await handle.dragTo(target, {
      targetPosition: { x: 120, y: box.height - 1 },
    });
  } else {
    const start = await handle.boundingBox();
    const session = await alice.context().newCDPSession(alice);
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [
        { x: start.x + start.width / 2, y: start.y + start.height / 2 },
      ],
      type: "touchStart",
    });
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [{ x: box.x + 120, y: box.y + box.height - 1 }],
      type: "touchMove",
    });
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [],
      type: "touchEnd",
    });
    await session.detach();
  }
  await expect
    .poll(async () => (await json()).content[0].content[0].text)
    .toBe("Second block.");
  await seed();
  await alice
    .getByRole("button", { exact: true, name: "Drag paragraph block" })
    .first()
    .press("ArrowDown");
  await expect
    .poll(async () => (await json()).content[0].content[0].text)
    .toBe("Second block.");
  await seed();
  await group("Text");
  await button("Bold").click();
  await contains('"type":"bold"');
  await button("Undo").click();
  await expect
    .poll(async () => JSON.stringify(await json()))
    .not.toContain('"type":"bold"');
  await button("Redo").click();
  await contains('"type":"bold"');
  await seed();
  await group("Insert");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64"
  );
  await alice.getByLabel("Upload image", { exact: true }).setInputFiles({
    buffer: png,
    mimeType: "image/png",
    name: "captured.png",
  });
  await expect(bob.locator(".tiptap img")).toHaveCount(1);
  await alice.evaluate(() =>
    Reflect.get(window, "roomFixtureEditor").commands.focus("end")
  );
  await alice.locator(".tiptap").evaluate(
    (node, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" })
      );
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        })
      );
    },
    [...png]
  );
  await expect(bob.locator(".tiptap img")).toHaveCount(2);
  await alice.evaluate(() =>
    Reflect.get(window, "roomFixtureEditor").commands.focus("end")
  );
  await alice
    .getByLabel("Image URL", { exact: true })
    .fill("https://public-images.example.com/captured.png");
  await button("Insert image URL").click();
  await expect(bob.locator(".tiptap img")).toHaveCount(3);
  await expect
    .poll(() =>
      bob
        .locator(".tiptap img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image.complete &&
              image.naturalWidth === 1 &&
              new URL(image.src).origin === location.origin
          )
        )
    )
    .toBe(true);
  // The download port reads the stored checkpoint, even with newer live edits.
  await call("/checkpoint", {});
  await alice.locator(".tiptap").press("ControlOrMeta+End");
  await alice.locator(".tiptap").pressSequentially("Uncheckpointed tail");
  await expect(bob.locator(".tiptap")).toContainText("Uncheckpointed tail");
  const downloadReady = alice.waitForEvent("download");
  await button("Download markdown").click();
  const download = await downloadReady;
  const stream = await download.createReadStream();
  let markdown = "";
  for await (const chunk of stream) {
    markdown += chunk.toString();
  }
  expect(markdown).toContain("Action sample.");
  expect(markdown).not.toContain("Uncheckpointed tail");
  await button("Version history").click();
  await button("Restore Initial fixture").click();
  await button("Confirm restore").click();
  await expect(bob.locator(".tiptap")).toContainText("Hello human.");
  await expect(bob.locator(".tiptap")).not.toContainText("Uncheckpointed tail");
  console.log(
    "Document mounted action matrix: text, all theme colours, case, toolbar/slash blocks, table mutations/colours, chips, keyboard block handle, undo/redo converge"
  );
}
