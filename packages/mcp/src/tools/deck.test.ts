import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Deck,
  parseSlide,
  type SlideData,
  serializeSlide,
} from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";
import { ToolError } from "../result";
import { connectClient, textOf } from "../testing";
import { type DeckReadResult, registerDeckTools } from "./deck";
import {
  createDeckCheckpoint,
  DeckSceneAdapter,
  type DeckScenePorts,
} from "./deck-scene";

const ID = "5b1c1a3e-0a52-4f5f-8f07-0b3d8e9a1c11";
const slide = (id = "s1", order = "a0"): SlideData => ({
  background: "#fff",
  duration: "0",
  elements: ["e1", "e2"].map((suffix, index) => ({
    id: `${id}${suffix}`,
    order: index ? "a1" : "a0",
    parent: id,
    props: { h: "50", w: "100", x: "0", y: "0" },
    style: {},
    text: [{ attrs: {}, children: ["hello"], tag: "p" }],
    type: "text",
  })),
  id,
  layout: { display: "flex" },
  notes: "notes",
  order,
  transition: "none",
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    // biome-ignore lint/performance/noAwaitInLoops: Close the transport before destroying its room.
    await cleanup();
  }
});
async function fixture(
  options: {
    dryRun?: boolean;
    readOnly?: boolean;
    authorize?: DeckScenePorts["authorize"];
  } = {}
) {
  const doc = new Doc({ gc: false });
  const deck = new Deck(doc, richTextCodec, { ownsBlob: () => false });
  deck.addSlide(slide());
  deck.addSlide(slide("s2", "a1"));
  const authorizations: string[] = [];
  const adapter = new DeckSceneAdapter({
    artifactId: ID,
    authority: deck,
    authorize: async (action, artifactId) => {
      authorizations.push(`${action}:${artifactId}`);
      await options.authorize?.(action, artifactId);
    },
    ownsBlob: () => false,
    presence: () => [{ id: "human", name: "Human", slideId: "s1" }],
  });
  const server = new McpServer({ name: "deck-test", version: "1" });
  const recorded: unknown[] = [];
  registerDeckTools(server, adapter, {
    readOnly: options.readOnly,
    ...(options.dryRun
      ? {
          dryRun: {
            record: (entry) => {
              recorded.push(entry);
              return Promise.resolve();
            },
          },
        }
      : {}),
  });
  const connection = await connectClient(server);
  cleanups.push(() => {
    adapter.destroy();
    deck.destroy();
    doc.destroy();
  }, connection.close);
  const call = (name: string, args: object) =>
    connection.client.callTool({
      arguments: args as Record<string, unknown>,
      name,
    });
  const read = async (slideIds?: string[]) => {
    const result = await call("deck_read", {
      artifactId: ID,
      ...(slideIds ? { slideIds } : {}),
    });
    if (result.isError) {
      throw new Error(textOf(result));
    }
    return result.structuredContent as unknown as DeckReadResult;
  };
  const write = (ops: unknown[]) => call("deck_write", { artifactId: ID, ops });
  return {
    adapter,
    authorizations,
    call,
    client: connection.client,
    deck,
    doc,
    read,
    recorded,
    write,
  };
}
const first = (read: DeckReadResult) => {
  const [value] = read.slides;
  if (!value) {
    throw new Error("expected slide");
  }
  return value;
};
const proposal = (html: string) => html.replace('x="0"', 'x="10"');

describe("deck MCP through real scene authority", () => {
  test("strict text-only read, selections, presence, annotations and authorized calls", async () => {
    const f = await fixture();
    const read = await f.read();
    expect(read.deck.order).toEqual(["s1", "s2"]);
    expect(read.present).toEqual([
      { id: "human", name: "Human", slideId: "s1" },
    ]);
    expect(read.slides).toHaveLength(2);
    expect((await f.read(["s2"])).slides.map((item) => item.id)).toEqual([
      "s2",
    ]);
    const result = await f.call("deck_read", { artifactId: ID });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("deck.json"),
        type: "text",
      }),
    ]);
    expect(textOf(result)).toContain("Human");
    const list = await f.client.listTools();
    expect(list.tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["deck_read", { readOnlyHint: true }],
      [
        "deck_write",
        { destructiveHint: false, idempotentHint: true, readOnlyHint: false },
      ],
    ]);
    expect(f.authorizations).toHaveLength(3);
    expect(
      (await f.call("deck_read", { artifactId: ID, present: [] })).isError
    ).toBe(true);
    expect((await f.read()).deck.sections).toEqual([]);
  });

  test("per-key agent diffs preserve unrelated human edits; changed elements skip", async () => {
    const f = await fixture();
    const observed = first(await f.read(["s1"]));
    f.deck.setElementKey("s1", "s1e1", "props", "x", "20");
    const html = observed.html
      .replaceAll('x="0"', 'x="10"')
      .replace('background="#fff"', 'background="#000"');
    const result = await f.write([
      { html, op: "write", revision: observed.revision, slideId: "s1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skipped: [{ id: "s1e1", index: 0, reason: "changed since read" }],
    });
    const current = f.deck.read("s1").slide;
    expect(current.elements.find((e) => e.id === "s1e1")?.props.x).toBe("20");
    expect(current.elements.find((e) => e.id === "s1e2")?.props.x).toBe("10");
    expect(current.background).toBe("#000");
    expect(
      textOf(
        await f.write([
          { html, op: "write", revision: observed.revision, slideId: "s1" },
        ])
      )
    ).toContain("guard_mismatch");
  });

  test("original remote edit/revert history prevents ABA and preserves untouched keys", async () => {
    const f = await fixture();
    const observed = first(await f.read(["s1"]));
    const remoteDoc = new Doc({ gc: false });
    const remote = new Deck(remoteDoc, richTextCodec);
    remote.applyUpdate(encodeStateAsUpdate(f.doc));
    remote.setElementKey("s1", "s1e1", "props", "x", "25");
    remote.setElementKey("s1", "s1e1", "props", "x", "0");
    f.deck.applyUpdate(encodeStateAsUpdate(remoteDoc));
    remote.destroy();
    remoteDoc.destroy();
    const result = await f.write([
      {
        html: proposal(observed.html),
        op: "write",
        revision: observed.revision,
        slideId: "s1",
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      skipped: [{ id: "s1e1" }],
    });
    expect(
      f.deck.read("s1").slide.elements.map((element) => element.props.x)
    ).toEqual(["0", "0"]);
  });

  test("batch rejection is atomic, invalidates tokens, and gives exact core HTML path", async () => {
    const f = await fixture();
    const observed = first(await f.read());
    const before = encodeStateAsUpdate(f.doc);
    let updates = 0;
    f.doc.on("update", () => {
      updates += 1;
    });
    const result = await f.write([
      {
        html: proposal(observed.html),
        op: "write",
        revision: observed.revision,
        slideId: "s1",
      },
      {
        html: '<slide id="bad" order="a2" background="#fff" transition="none" duration="0"><script>evil</script></slide>',
        op: "add",
      },
    ]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("validation: /slide");
    expect(encodeStateAsUpdate(f.doc)).toEqual(before);
    expect(updates).toBe(0);
    expect(
      textOf(
        await f.write([
          { op: "delete", revision: observed.revision, slideId: "s1" },
        ])
      )
    ).toContain("guard_mismatch");
  });

  test("add/reorder/theme/delete commit in one update and persist in actual Y.Doc", async () => {
    const f = await fixture();
    const read = await f.read();
    let updates = 0;
    f.doc.on("update", () => {
      updates += 1;
    });
    const result = await f.write([
      { html: serializeSlide(slide("s3", "a2"), richTextCodec), op: "add" },
      {
        op: "reorder",
        revision: read.deck.revision,
        slideIds: ["s3", "s2", "s1"],
      },
      {
        op: "theme",
        revision: read.deck.revision,
        theme: { colors: { accent: "#123456" }, fonts: {}, sizes: {} },
      },
      { op: "delete", revision: first(read).revision, slideId: "s1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(f.deck.ids()).toEqual(["s3", "s2"]);
    expect(f.deck.theme().colors.accent).toBe("#123456");
    expect(updates).toBe(1);
    expect(f.doc.getMap("slides").size).toBe(2);
  });

  test("human edit/revert guards deletion, reorder and individual theme keys", async () => {
    const f = await fixture();
    f.deck.setTheme({
      colors: { accent: "#fff", paper: "#fff" },
      fonts: {},
      sizes: {},
    });
    const read = await f.read();
    f.deck.updateSlide("s1", { notes: "human" });
    f.deck.updateSlide("s1", { notes: "notes" });
    f.deck.setTheme({
      colors: { accent: "#000", paper: "#fff" },
      fonts: {},
      sizes: {},
    });
    f.deck.setTheme({
      colors: { accent: "#fff", paper: "#fff" },
      fonts: {},
      sizes: {},
    });
    const result = await f.write([
      { op: "delete", revision: first(read).revision, slideId: "s1" },
      { op: "reorder", revision: read.deck.revision, slideIds: ["s2", "s1"] },
      {
        op: "theme",
        revision: read.deck.revision,
        theme: {
          colors: { accent: "#123456", paper: "#000" },
          fonts: {},
          sizes: {},
        },
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skipped: [
        { id: "s1" },
        { id: "order" },
        { id: "meta/theme/colors/accent" },
      ],
    });
    expect(f.deck.ids()).toEqual(["s1", "s2"]);
    expect(f.deck.theme().colors).toEqual({ accent: "#fff", paper: "#000" });
  });

  test("no forged observations, missing guards, force, raw scene or arbitrary paths", async () => {
    const f = await fixture();
    const observed = first(await f.read());
    for (const op of [
      { html: observed.html, op: "write", slideId: "s1" },
      {
        html: observed.html,
        op: "write",
        revision: { revision: observed.revision, slide: slide() },
        slideId: "s1",
      },
      {
        force: true,
        html: observed.html,
        op: "write",
        revision: observed.revision,
        slideId: "s1",
      },
      { op: "set", path: "__proto__", value: "evil" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each rejected call must leave the same room unchanged.
      expect((await f.write([op])).isError).toBe(true);
    }
    expect(
      textOf(
        await f.write([
          { op: "delete", revision: observed.revision, slideId: "s2" },
        ])
      )
    ).toContain("guard_mismatch");
  });

  test("malicious HTML, attributes, links and owned-blob paths never reach scene", async () => {
    const f = await fixture();
    for (const malicious of [
      "<script>bad</script>",
      '<p onclick="bad">bad</p>',
      '<p><a href="javascript:alert(1)">bad</a></p>',
      '<p><span style="color: #fff; color: red">bad</span></p>',
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: A failed batch expires observations; each attempt needs a fresh read.
      const observed = first(await f.read());
      const before = encodeStateAsUpdate(f.doc);
      const html = observed.html.replace("<p>hello</p>", malicious);
      expect(
        (
          await f.write([
            { html, op: "write", revision: observed.revision, slideId: "s1" },
          ])
        ).isError
      ).toBe(true);
      expect(encodeStateAsUpdate(f.doc)).toEqual(before);
    }
    const read = await f.read();
    // Serializer/core admission is authoritative; raw HTML cannot bypass ownership.
    const html =
      '<slide id="bad" order="a2" background="#fff" transition="none" duration="0"><element id="image" type="image" parent="bad" order="a0" prop-src="/files/../secret" prop-x="0" prop-y="0" prop-w="10" prop-h="10"></element></slide>';
    expect((await f.write([{ html, op: "add" }])).isError).toBe(true);
    const foreign = html.replace("/files/../secret", "/files/other-room/image");
    expect(textOf(await f.write([{ html: foreign, op: "add" }]))).toContain(
      "blob does not belong to artifact"
    );
    expect(f.deck.ids()).toEqual(read.deck.order);
  });

  test("malicious raw marks rejected by actual core admission without poisoning observations", async () => {
    const f = await fixture();
    const observed = first(await f.read());
    const remoteDoc = new Doc();
    const remote = new Deck(remoteDoc, richTextCodec);
    remote.applyUpdate(encodeStateAsUpdate(f.doc));
    const fragment = remote.textFragment("s1", "s1e1");
    const paragraph = fragment.get(0);
    if (paragraph instanceof XmlElement) {
      const text = paragraph.get(0);
      if (text instanceof XmlText) {
        text.format(0, 1, { evil: true });
      }
    }
    const before = encodeStateAsUpdate(f.doc);
    expect(() => f.deck.applyUpdate(encodeStateAsUpdate(remoteDoc))).toThrow();
    expect(encodeStateAsUpdate(f.doc)).toEqual(before);
    remote.destroy();
    remoteDoc.destroy();
    expect(
      (
        await f.write([
          {
            html: proposal(observed.html),
            op: "write",
            revision: observed.revision,
            slideId: "s1",
          },
        ])
      ).isError
    ).toBeUndefined();
  });

  test("dry run bypasses all writes; read-only registration omits writes", async () => {
    const f = await fixture({ dryRun: true });
    const observed = first(await f.read());
    const before = encodeStateAsUpdate(f.doc);
    expect(
      textOf(
        await f.write([
          { op: "delete", revision: observed.revision, slideId: "s1" },
        ])
      )
    ).toContain("Skipped in dry run");
    expect(f.recorded).toHaveLength(1);
    expect(f.authorizations).toHaveLength(1);
    expect(encodeStateAsUpdate(f.doc)).toEqual(before);
    const restricted = await fixture({ readOnly: true });
    expect(
      (await restricted.client.listTools()).tools.map((tool) => tool.name)
    ).toEqual(["deck_read"]);
  });

  test("mandatory auth ports, viewer/guest role refusal and cross-artifact isolation", async () => {
    const f = await fixture({
      authorize: (action) => {
        if (action === "write") {
          return Promise.reject(
            new ToolError("forbidden", "Guest viewer cannot edit")
          );
        }
        return Promise.resolve();
      },
    });
    const read = await f.read();
    expect(
      textOf(
        await f.write([
          { op: "delete", revision: first(read).revision, slideId: "s1" },
        ])
      )
    ).toContain("forbidden: Guest viewer cannot edit");
    expect(
      textOf(
        await f.call("deck_read", {
          artifactId: "5b1c1a3e-0a52-4f5f-8f07-0b3d8e9a1c12",
        })
      )
    ).toContain("forbidden");
    expect(
      () =>
        new DeckSceneAdapter({
          artifactId: ID,
          authority: f.deck,
        } as DeckScenePorts)
    ).toThrow("Authorized scene ports");
    f.adapter.destroy();
    expect(textOf(await f.call("deck_read", { artifactId: ID }))).toContain(
      "Room closed"
    );
  });
  test("independent layout keys merge and edited rich text is skipped", async () => {
    const f = await fixture();
    const observed = first(await f.read(["s1"]));
    f.deck.updateSlide("s1", {
      layout: { display: "grid" },
      notes: "Human notes",
    });
    f.deck.updateElement("s1", "s1e1", {
      text: [{ attrs: {}, children: ["Human words"], tag: "p" }],
    });
    const html = observed.html
      .replace(
        'layout-display="flex"',
        'layout-display="flex" layout-gap="12px"'
      )
      .replaceAll("hello", "Agent words");
    const result = await f.write([
      { html, op: "write", revision: observed.revision, slideId: "s1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skipped: [{ id: "s1e1" }],
    });
    const current = f.deck.read("s1").slide;
    expect(current.layout).toEqual({ display: "grid", gap: "12px" });
    expect(current.notes).toBe("Human notes");
    expect(serializeSlide(current, richTextCodec)).toContain("Human words");
    expect(serializeSlide(current, richTextCodec)).toContain("Agent words");
  });

  test("deleted/recreated slides are never overwritten or deleted by an old observation", async () => {
    const f = await fixture();
    const read = await f.read();
    const observed = first(read);
    f.deck.deleteSlide("s1");
    f.deck.addSlide(slide());
    const result = await f.write([
      {
        html: proposal(observed.html),
        op: "write",
        revision: observed.revision,
        slideId: "s1",
      },
      { op: "delete", revision: observed.revision, slideId: "s1" },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skipped: [{ id: "s1e1" }, { id: "s1" }],
    });
    expect(f.deck.ids()).toContain("s1");
    const fresh = first(await f.read(["s1"]));
    f.deck.deleteSlide("s1");
    const gone = await f.write([
      {
        html: fresh.html,
        op: "write",
        revision: fresh.revision,
        slideId: "s1",
      },
    ]);
    expect(gone.structuredContent).toMatchObject({
      skipped: [{ reason: "slide deleted since read; do not recreate" }],
    });
  });

  test("invalid reorder/theme abort earlier additions with no update event", async () => {
    const f = await fixture();
    const read = await f.read();
    const before = encodeStateAsUpdate(f.doc);
    const reorder = await f.write([
      { html: serializeSlide(slide("s3", "a2"), richTextCodec), op: "add" },
      { op: "reorder", revision: read.deck.revision, slideIds: ["s1", "s1"] },
    ]);
    expect(textOf(reorder)).toContain(
      "/slideIds: reorder must contain every current slide exactly once"
    );
    expect(encodeStateAsUpdate(f.doc)).toEqual(before);
    const fresh = await f.read();
    const invalid = await f.write([
      { op: "delete", revision: first(fresh).revision, slideId: "s1" },
      {
        op: "theme",
        revision: fresh.deck.revision,
        theme: { colors: { accent: "url(evil)" }, fonts: {}, sizes: {} },
      },
    ]);
    expect(textOf(invalid)).toContain("validation: /meta/theme");
    expect(encodeStateAsUpdate(f.doc)).toEqual(before);
  });

  test("creation checkpoint uses core codec, title and whole-scene validation", () => {
    const checkpoint = createDeckCheckpoint(
      { slides: [serializeSlide(slide(), richTextCodec)], title: "New deck" },
      () => false
    );
    const doc = new Doc();
    const deck = new Deck(doc, richTextCodec);
    try {
      deck.applyUpdate(checkpoint);
      expect(deck.ids()).toEqual(["s1"]);
      expect(doc.getMap("meta").get("title")).toBe("New deck");
      expect(() =>
        createDeckCheckpoint(
          { slides: ["<script></script>"], title: "Bad" },
          () => false
        )
      ).toThrow(ToolError);
    } finally {
      deck.destroy();
      doc.destroy();
    }
  });

  test("HTML error translation preserves exact core path and diagnostic", async () => {
    const f = await fixture();
    const observed = first(await f.read());
    const html = observed.html.replace('prop-x="0"', 'prop-x="NaN"');
    let expected = "";
    try {
      parseSlide(html, richTextCodec);
    } catch (error) {
      if (error instanceof Error) {
        expected = error.message;
      }
    }
    expect(expected).toContain("/slide[@id='s1']/element[@id='s1e1']/@prop-x");
    const result = await f.write([
      { html, op: "write", revision: observed.revision, slideId: "s1" },
    ]);
    expect(result.structuredContent).toEqual({
      code: "validation",
      message: expected,
    });
  });
});
