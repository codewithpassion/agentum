// biome-ignore-all lint/style/noNonNullAssertion: Test fixtures assert the expected blocks exist.
import { expect, test } from "bun:test";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  type XmlElement,
  type XmlText,
} from "yjs";
import { hashBlock, LiveDocument } from "./document";
import {
  fromMarkdown,
  safeLink,
  sanitizeJSON,
  schema,
  toMarkdown,
} from "./schema";

const urls = [
  "javascript:alert(1)",
  "java\nscript:alert(1)",
  "data:text/html,test",
  "vbscript:msgbox(1)",
  "//evil.test/image",
  "/\\evil.test",
  "/%2fevil.test",
  "https://ok.test\u0000.evil.test",
  "file:///etc/passwd",
];
const styles = [
  "url(https://evil.test)",
  "expression(alert(1))",
  "var(--attack)",
  "red; background:url(x)",
  '#fff" onmouseover=alert(1)',
];
test("hostile corpus for JSON, markdown, create/import, restore and agent content", () => {
  for (const url of urls) {
    expect(safeLink(url)).toBeUndefined();
  }
  for (const url of urls) {
    for (const style of styles) {
      const hostile = {
        content: [
          { attrs: { src: url }, type: "script" },
          { attrs: { onerror: "alert(1)", src: url }, type: "image" },
          {
            attrs: { onclick: "alert(1)", style },
            content: [
              {
                marks: [
                  { attrs: { href: url }, type: "link" },
                  { attrs: { color: style }, type: "textStyle" },
                  { type: "evil" },
                ],
                text: "text <script> is text",
                type: "text",
              },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      };
      const clean = sanitizeJSON(hostile);
      const json = JSON.stringify(clean);
      expect(json).not.toContain('"href"');
      expect(json).not.toContain('"image"');
      expect(json).not.toContain('"style"');
      expect(json).not.toContain('"onclick"');
      schema.nodeFromJSON(clean).check();
      const live = new LiveDocument(new Doc());
      live.import({ json: hostile }, "restore");
      expect(hashBlock(live.json())).toBe(hashBlock(clean));
      live.apply([{ content: { json: hostile }, op: "insert" }], {});
      schema.nodeFromJSON(live.json()).check();
      const markdown = fromMarkdown(
        `<script src="${url}">attack</script>\n\n[bad](${url})\n\n![x](${url})`
      );
      expect(JSON.stringify(markdown)).not.toContain('"image"');
      expect(JSON.stringify(markdown)).not.toContain('"html"');
      live.destroy();
      live.doc.destroy();
    }
  }
});
test("own blob allowlist prevents third-party requests; safe links and theme colors survive", () => {
  const policy = { ownBlobUrls: new Set(["/files/owned/image.png"]) };
  const json = sanitizeJSON(
    {
      content: [
        { attrs: { src: "/files/owned/image.png" }, type: "image" },
        { attrs: { src: "/files/other/image.png" }, type: "image" },
        { attrs: { src: "https://evil/image.png" }, type: "image" },
      ],
      type: "doc",
    },
    policy
  );
  expect(json.content).toHaveLength(1);
  expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
  expect(safeLink("mailto:a@example.com")).toBe("mailto:a@example.com");
  expect(safeLink("/a/abc")).toBe("/a/abc");
});
test("raw hostile Yjs update is rejected without mutating live state", () => {
  const live = new LiveDocument(new Doc());
  live.import({ text: "safe" }, "init");
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(live.doc));
  const el = replica.getXmlFragment("content").get(0) as XmlElement;
  const text = el.get(0) as XmlText;
  text.format(0, text.length, { link: { href: "javascript:alert(1)" } });
  const before = encodeStateAsUpdate(live.doc);
  expect(() =>
    live.applyUpdate(encodeStateAsUpdate(replica), "socket")
  ).toThrow("invalid_content");
  expect(encodeStateAsUpdate(live.doc)).toEqual(before);
});
test("deterministic hostile JSON fuzz validates schema and sanitizer idempotence", () => {
  let seed = 123_456;
  const random = () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: Deterministic unsigned LCG for reproducible fuzzing.
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const types = [
    "paragraph",
    "heading",
    "text",
    "image",
    "script",
    "iframe",
    "table",
    "tableRow",
    "tableCell",
    "pending",
    "mention",
    "date",
    "html",
    "taskList",
    "taskItem",
  ];
  const generate = (depth: number): unknown => ({
    attrs: {
      checked: true,
      color: styles[random() % styles.length],
      href: urls[random() % urls.length],
      level: random() % 9,
      src: urls[random() % urls.length],
      style: styles[random() % styles.length],
    },
    content: depth
      ? Array.from({ length: random() % 4 }, () => generate(depth - 1))
      : [],
    marks: [{ attrs: { href: urls[random() % urls.length] }, type: "link" }],
    text: random() % 2 ? "<img src=x onerror=alert(1)>" : "plain",
    type: types[random() % types.length],
  });
  for (let i = 0; i < 1000; i += 1) {
    const clean = sanitizeJSON({ content: [generate(4)], type: "doc" });
    schema.nodeFromJSON(clean).check();
    expect(sanitizeJSON(clean)).toEqual(clean);
    expect(() => toMarkdown(clean)).not.toThrow();
  }
});

test("sanitized schema renders hostile corpus as inert DOM, with no unsafe attributes or remote images", async () => {
  const { Window } = await import("happy-dom");
  const { DOMSerializer } = await import("@tiptap/pm/model");
  const window = new Window();
  const { document } = window;
  for (const url of urls) {
    const clean = sanitizeJSON({
      content: [
        {
          content: [
            {
              marks: [
                { attrs: { href: url }, type: "link" },
                { attrs: { color: "url(https://evil)" }, type: "textStyle" },
              ],
              text: '<img src="x" onerror="alert(1)">',
              type: "text",
            },
          ],
          type: "paragraph",
        },
        { attrs: { src: url }, type: "image" },
      ],
      type: "doc",
    });
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      schema.nodeFromJSON(clean).content,
      { document: document as unknown as Document }
    );
    const container = document.createElement("div");
    container.append(
      fragment as unknown as Parameters<typeof container.append>[0]
    );
    expect(
      container.querySelector(
        "script, iframe, img, [onerror], [onclick], [style], a"
      )
    ).toBeNull();
    expect(container.textContent).toBe('<img src="x" onerror="alert(1)">');
  }
  await window.happyDOM.close();
});

test("editor transaction gate rejects unsafe links and styles before publishing", async () => {
  const { EditorState } = await import("@tiptap/pm/state");
  const { createSanitizerPlugin } = await import("./schema");
  const state = EditorState.create({
    doc: schema.nodeFromJSON(fromMarkdown("safe text")),
    plugins: [createSanitizerPlugin()],
    schema,
  });
  for (const href of urls) {
    const transaction = state.tr.addMark(
      1,
      5,
      schema.marks.link!.create({ href })
    );
    expect(state.applyTransaction(transaction).transactions).toHaveLength(0);
  }
  for (const color of styles) {
    const transaction = state.tr.addMark(
      1,
      5,
      schema.marks.textStyle!.create({ color })
    );
    expect(state.applyTransaction(transaction).transactions).toHaveLength(0);
  }
  const valid = state.tr.addMark(
    1,
    5,
    schema.marks.link!.create({ href: "https://example.com" })
  );
  expect(state.applyTransaction(valid).transactions).toHaveLength(1);
});
test("unknown raw XML attributes and out-of-order incomplete updates never enter authoritative state", () => {
  const live = new LiveDocument(new Doc());
  live.import({ text: "safe" }, "init");
  const replica = new Doc();
  applyUpdate(replica, encodeStateAsUpdate(live.doc));
  (replica.getXmlFragment("content").get(0) as XmlElement).setAttribute(
    "onclick",
    "alert(1)"
  );
  const before = encodeStateAsUpdate(live.doc);
  expect(() =>
    live.applyUpdate(encodeStateAsUpdate(replica), "socket")
  ).toThrow("invalid_content");
  expect(encodeStateAsUpdate(live.doc)).toEqual(before);
});
test("markdown drops raw HTML in DOM and no-DOM runtimes while preserving code and autolinks", async () => {
  const input =
    'before <b>bold</b> after\n\n<script>alert(1)</script>\n\n```html\n<img src="code">\n```\n\n`<span>`\n\n<https://example.com>\n\n<!-- unclosed';
  const json = fromMarkdown(input);
  const serialized = JSON.stringify(json);
  expect(serialized).toContain('<img src=\\"code\\">');
  expect(serialized).toContain("<span>");
  expect(serialized).toContain("https://example.com");
  expect(serialized).not.toContain("alert(1)");
  const { Window } = await import("happy-dom");
  const window = new Window();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  try {
    expect(fromMarkdown(input)).toEqual(json);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    await window.happyDOM.close();
  }
  expect(() =>
    sanitizeJSON({
      content: [
        {
          content: [{ marks: [null, 17, "bad", {}], text: "x", type: "text" }],
          type: "paragraph",
        },
      ],
      type: "doc",
    })
  ).not.toThrow();
});

test("editor gate accepts safe edits with independently constructed editor schema", async () => {
  const { getSchema } = await import("@tiptap/core");
  const { createExtensions, createSanitizerPlugin } = await import("./schema");
  const { EditorState } = await import("@tiptap/pm/state");
  const editorSchema = getSchema(createExtensions());
  const state = EditorState.create({
    doc: editorSchema.nodeFromJSON(fromMarkdown("hello")),
    plugins: [createSanitizerPlugin()],
    schema: editorSchema,
  });
  expect(
    state.applyTransaction(state.tr.insertText(" world", 6)).transactions
  ).toHaveLength(1);
});
test("incomplete incremental update is refused until its dependencies are resent", async () => {
  const { encodeStateVector } = await import("yjs");
  const source = new LiveDocument(new Doc());
  source.import({ text: "initial" }, "init");
  const vector = encodeStateVector(source.doc);
  const first = source.read().blocks[0]!;
  source.apply(
    [
      {
        at: source.position(first.id, 0),
        content: { text: "later " },
        op: "insert",
      },
    ],
    {}
  );
  const target = new LiveDocument(new Doc());
  const before = encodeStateAsUpdate(target.doc);
  expect(() =>
    target.applyUpdate(encodeStateAsUpdate(source.doc, vector), "socket")
  ).toThrow("invalid_content");
  expect(encodeStateAsUpdate(target.doc)).toEqual(before);
  target.applyUpdate(encodeStateAsUpdate(source.doc), "socket");
  expect(target.markdown()).toBe("later initial");
});

test("hostile ingress fuzz reaches create, agent, markdown, binary editor and checkpoint restore before DOM rendering", async () => {
  const { Window } = await import("happy-dom");
  const { DOMSerializer } = await import("@tiptap/pm/model");
  const window = new Window();
  const assertDOM = (live: LiveDocument) => {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      schema.nodeFromJSON(live.json()).content,
      { document: window.document as unknown as Document }
    );
    const container = window.document.createElement("div");
    container.append(
      fragment as unknown as Parameters<typeof container.append>[0]
    );
    expect(
      container.querySelector(
        "script,iframe,object,embed,img,[onclick],[onerror],[style],a"
      )
    ).toBeNull();
  };
  try {
    for (let i = 0; i < 100; i += 1) {
      const url = urls[i % urls.length];
      const style = styles[(i * 7) % styles.length];
      const payload = {
        content: [
          { attrs: { html: `<svg onload=alert(${i})>` }, type: "html" },
          { attrs: { onerror: "alert(1)", src: url }, type: "image" },
          {
            attrs: { style },
            content: [
              {
                marks: [
                  { attrs: { href: url }, type: "link" },
                  { attrs: { color: style }, type: "textStyle" },
                ],
                text: `Text ${i} <img onerror=alert(1)>`,
                type: "text",
              },
            ],
            type: "paragraph",
          },
        ],
        type: "doc",
      };
      const live = new LiveDocument(new Doc());
      live.import({ json: payload }, "create");
      assertDOM(live);
      live.apply([{ content: { json: payload }, op: "insert" }], {});
      assertDOM(live);
      const checkpoint = encodeStateAsUpdate(live.doc);
      live.import(
        {
          markdown: `<script>attack</script>\n\n[bad](${url})\n\n![tracking](${url})`,
        },
        "markdown"
      );
      assertDOM(live);
      live.restoreSnapshot(checkpoint, "restore");
      assertDOM(live);
      const replica = new LiveDocument(new Doc());
      replica.applyUpdate(encodeStateAsUpdate(live.doc), "socket");
      assertDOM(replica);
      live.destroy();
      live.doc.destroy();
      replica.destroy();
      replica.doc.destroy();
    }
  } finally {
    await window.happyDOM.close();
  }
});

test("binary hidden mark attributes and malformed mark values cannot enter any state ingress", () => {
  for (const mark of [
    {
      link: {
        evil: "yes",
        href: "https://example.com",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    },
    { bold: { evil: "yes" } },
    { link: "https://example.com" },
    { bold: [] },
  ]) {
    const live = new LiveDocument(new Doc());
    live.import({ text: "safe" }, "init");
    const replica = new Doc();
    applyUpdate(replica, encodeStateAsUpdate(live.doc));
    const paragraph = replica.getXmlFragment("content").get(0) as XmlElement;
    (paragraph.get(0) as XmlText).format(0, 1, mark);
    const hostile = encodeStateAsUpdate(replica);
    const before = encodeStateAsUpdate(live.doc);
    let updates = 0;
    live.doc.on("update", () => {
      updates += 1;
    });
    expect(() => live.applyUpdate(hostile, "socket")).toThrow(
      "invalid_content"
    );
    expect(() => live.restoreSnapshot(hostile, "restore")).toThrow(
      "invalid_content"
    );
    expect(() => new LiveDocument(replica)).toThrow("invalid_content");
    expect(encodeStateAsUpdate(live.doc)).toEqual(before);
    expect(updates).toBe(0);
    replica.destroy();
    live.destroy();
    live.doc.destroy();
  }
});
