import { describe, expect, test } from "bun:test";
import type {
  ArtifactPublished,
  ArtifactReadInfo,
  ArtifactsPort,
  ArtifactTestInfo,
} from "../ports";
import { ToolError } from "../result";
import { agentumTools } from "../server";
import { textOf } from "../testing";
import { READ_ONLY, WRITE_CREATE, WRITE_UPDATE } from "./define";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const ID = "5b1c1a3e-0a52-4f5f-8f07-0b3d8e9a1c11";
const URL = `https://app.example/a/${ID}`;

const published: ArtifactPublished = {
  artifactId: ID,
  bytes: 12,
  files: 1,
  url: URL,
  version: 1,
  versionId: "ver_1",
};

const uncalled = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} should not be called`));

const port = (overrides: Partial<ArtifactsPort> = {}): ArtifactsPort => ({
  create: uncalled("create"),
  list: uncalled("list"),
  promote: uncalled("promote"),
  read: uncalled("read"),
  test: uncalled("test"),
  update: uncalled("update"),
  ...overrides,
});

const call = (
  artifacts: ArtifactsPort,
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof callTool>[3] = {}
) => callTool(fakePorts({ artifacts }), name, args, options);

const html = { path: "index.html", text: "<h1>Hi</h1>" };

describe("registration", () => {
  const tools = agentumTools(fakePorts({ artifacts: port() }));
  const find = (name: string) => tools.find((tool) => tool.name === name);

  test("the tools carry the spec's annotations", () => {
    expect(find("artifact_create")?.annotations).toEqual(WRITE_CREATE);
    expect(find("artifact_update")?.annotations).toEqual(WRITE_UPDATE);
    expect(find("artifact_promote")?.annotations).toEqual(WRITE_UPDATE);
    for (const name of ["artifact_read", "artifact_list", "artifact_test"]) {
      expect(find(name)?.annotations).toEqual(READ_ONLY);
    }
  });

  test("they are offered only when the app supplies the port", () => {
    const names = agentumTools(fakePorts()).map((tool) => tool.name);
    expect(names.some((name) => name.startsWith("artifact_"))).toBe(false);
  });

  test("a read-only caller gets the three read tools", () => {
    const names = agentumTools(fakePorts({ artifacts: port() }), {
      readOnly: true,
    })
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("artifact_"))
      .sort();
    expect(names).toEqual(["artifact_list", "artifact_read", "artifact_test"]);
  });

  test("descriptions tell agents how to build and to test", () => {
    for (const name of ["artifact_create", "artifact_update"]) {
      const description = find(name)?.description ?? "";
      expect(description).toContain("task folder");
      expect(description).toContain("relative paths");
      expect(description).toContain("data.json");
      expect(description).toContain("artifact_test");
    }
    expect(find("artifact_test")?.description).toContain("after every");
  });
});

describe("artifact_create", () => {
  test("forwards the input with the default entry and returns the result", async () => {
    let received: unknown;
    const result = await call(
      port({
        create: (input) => {
          received = input;
          return Promise.resolve(published);
        },
      }),
      "artifact_create",
      { files: [html], kind: "page", title: "Hello" }
    );
    expect(result.isError).toBeFalsy();
    expect(received).toEqual({
      entry: "index.html",
      files: [html],
      kind: "page",
      title: "Hello",
    });
    expect(result.structuredContent).toEqual(published);
    expect(textOf(result)).toContain(URL);
    expect(textOf(result)).toContain("artifact_test");
  });

  test("a doc defaults to index.md", async () => {
    let entry: string | undefined;
    await call(
      port({
        create: (input) => {
          ({ entry } = input);
          return Promise.resolve(published);
        },
      }),
      "artifact_create",
      { files: [{ path: "index.md", text: "# Hi" }], kind: "doc", title: "D" }
    );
    expect(entry).toBe("index.md");
  });

  test("accepts fromLibraryPath", async () => {
    let received: unknown;
    const result = await call(
      port({
        create: (input) => {
          received = input;
          return Promise.resolve(published);
        },
      }),
      "artifact_create",
      {
        fromLibraryPath: "agents/ops/tasks/run_1",
        kind: "dashboard",
        title: "D",
      }
    );
    expect(result.isError).toBeFalsy();
    expect(received).toMatchObject({
      fromLibraryPath: "agents/ops/tasks/run_1",
    });
  });

  test("the result carries no token, even if the port returns one", async () => {
    const result = await call(
      port({
        create: () =>
          Promise.resolve({
            ...published,
            shareToken: "hm_share_abc",
            viewToken: "hm_view_abc.def",
          } as ArtifactPublished),
      }),
      "artifact_create",
      { files: [html], kind: "page", title: "Hello" }
    );
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("hm_view_");
    expect(everything).not.toContain("hm_share_");
  });

  test("dry run skips the write and says what it would do", async () => {
    const recorded: { summary: string; tool: string }[] = [];
    const result = await call(
      port(),
      "artifact_create",
      { files: [html], kind: "page", title: "Hello" },
      {
        dryRun: {
          record: (skip) => {
            recorded.push(skip);
            return Promise.resolve();
          },
        },
      }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toStartWith(
      "Skipped in dry run: would create an artifact "
    );
    expect(recorded.map((skip) => skip.tool)).toEqual(["artifact_create"]);
  });
});

describe("artifact_update", () => {
  test("forwards baseVersion and returns the new version", async () => {
    let received: unknown;
    const result = await call(
      port({
        update: (input) => {
          received = input;
          return Promise.resolve({ ...published, version: 3 });
        },
      }),
      "artifact_update",
      { artifactId: ID, baseVersion: 2, files: [html], title: "New" }
    );
    expect(result.isError).toBeFalsy();
    expect(received).toEqual({
      artifactId: ID,
      baseVersion: 2,
      files: [html],
      title: "New",
    });
    expect(result.structuredContent).toMatchObject({ version: 3 });
  });

  test("dry run skips the write", async () => {
    const result = await call(
      port(),
      "artifact_update",
      { artifactId: ID, baseVersion: 2, files: [html] },
      { dryRun: { record: () => Promise.resolve() } }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toStartWith(
      "Skipped in dry run: would update an artifact "
    );
  });

  test("a stale base comes back as conflict with the current version", async () => {
    const result = await call(
      port({
        update: () =>
          Promise.reject(
            new ToolError(
              "conflict",
              "baseVersion 2 is stale; the current version is 4. Read it and retry."
            )
          ),
      }),
      "artifact_update",
      { artifactId: ID, baseVersion: 2, files: [html] }
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "conflict",
      message:
        "baseVersion 2 is stale; the current version is 4. Read it and retry.",
    });
    expect(textOf(result)).toContain("current version is 4");
  });
});

describe("errors", () => {
  const failWith = (code: ConstructorParameters<typeof ToolError>[0]) =>
    port({
      create: () =>
        Promise.reject(new ToolError(code, `from the port: ${code}`)),
      read: () => Promise.reject(new ToolError(code, `from the port: ${code}`)),
      update: () =>
        Promise.reject(new ToolError(code, `from the port: ${code}`)),
    });

  test("forbidden and not_found from the port reach the agent", async () => {
    await Promise.all(
      (["forbidden", "not_found"] as const).map(async (code) => {
        const updated = await call(failWith(code), "artifact_update", {
          artifactId: ID,
          baseVersion: 1,
          files: [html],
        });
        expect(updated.structuredContent).toEqual({
          code,
          message: `from the port: ${code}`,
        });
        const read = await call(failWith(code), "artifact_read", {
          artifactId: ID,
        });
        expect(read.structuredContent).toMatchObject({ code });
      })
    );
  });

  const validation = async (args: Record<string, unknown>) => {
    const result = await call(port(), "artifact_create", {
      kind: "page",
      title: "T",
      ...args,
    });
    const text = textOf(result);
    return result.isError && text.startsWith("validation: ")
      ? text
      : `Not a validation error: ${text}`;
  };

  test("needs exactly one of files and fromLibraryPath", async () => {
    expect(await validation({})).toContain("exactly one of files");
    expect(
      await validation({ files: [html], fromLibraryPath: "agents/a/tasks/r" })
    ).toContain("exactly one of files");
  });

  test("needs the entry among the files", async () => {
    expect(
      await validation({ files: [{ path: "home.html", text: "x" }] })
    ).toContain('"index.html"');
    expect(await validation({ entry: "x.html", files: [html] })).toContain(
      "not one of the files"
    );
  });

  test("refuses bad, reserved and repeated paths", async () => {
    const texts = await Promise.all(
      ["/abs.html", "../up.html", "a//b.html", "_hm/x.js"].map((path) =>
        validation({ files: [html, { path, text: "x" }] })
      )
    );
    for (const text of texts) {
      expect(text).toContain("Bad path");
    }
    expect(await validation({ files: [html, html] })).toContain("twice");
  });

  test("a file takes exactly one of text and base64", async () => {
    expect(await validation({ files: [{ path: "index.html" }] })).toContain(
      "exactly one of text or base64"
    );
    expect(
      await validation({
        files: [{ base64: "aGk=", path: "index.html", text: "x" }],
      })
    ).toContain("exactly one of text or base64");
    expect(
      await validation({ files: [{ base64: "!!", path: "index.html" }] })
    ).toContain("base64");
  });

  test("enforces the file count and size limits", async () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      path: index === 0 ? "index.html" : `f${index}.txt`,
      text: "x",
    }));
    expect(await validation({ files: many })).toContain("200 files");
    const big = "a".repeat(10 * 1024 * 1024 + 1);
    expect(
      await validation({ files: [{ path: "index.html", text: big }] })
    ).toContain("over 10 MB");
    const ten = "a".repeat(10 * 1024 * 1024);
    expect(
      await validation({
        files: [
          { path: "index.html", text: ten },
          { path: "b.txt", text: "b".repeat(7 * 1024 * 1024) },
        ],
      })
    ).toContain("16 MB");
  });

  test("schema limits on title and kind come back as errors", async () => {
    const tooLong = await call(port(), "artifact_create", {
      files: [html],
      kind: "page",
      title: "t".repeat(121),
    });
    expect(tooLong.isError).toBe(true);
    const app = await call(port(), "artifact_create", {
      files: [html],
      kind: "app",
      title: "T",
    });
    expect(app.isError).toBe(true);
  });
});

describe("artifact_read and artifact_list", () => {
  const info: ArtifactReadInfo = {
    artifactId: ID,
    audience: "workspace",
    currentVersion: 2,
    description: "A page",
    file: {
      contentType: "text/html; charset=utf-8",
      path: "index.html",
      size: 11,
      text: "<h1>Hi</h1>",
      version: 2,
    },
    kind: "page",
    title: "Hello",
    url: URL,
    versions: [
      {
        authorKind: "agent",
        createdAt: "2026-10-27T10:00:00.000Z",
        message: "second",
        number: 2,
        versionId: "ver_2",
      },
    ],
  };

  test("read forwards its input and shows versions and the file text", async () => {
    let received: unknown;
    const result = await call(
      port({
        read: (input) => {
          received = input;
          return Promise.resolve(info);
        },
      }),
      "artifact_read",
      { artifactId: ID, path: "index.html", version: 2 }
    );
    expect(received).toEqual({
      artifactId: ID,
      path: "index.html",
      version: 2,
    });
    expect(result.structuredContent).toEqual(info);
    expect(textOf(result)).toContain("v2 by agent");
    expect(textOf(result)).toContain("<h1>Hi</h1>");
  });

  test("list returns items and the next cursor", async () => {
    const items = [
      {
        artifactId: ID,
        audience: "workspace",
        currentVersion: 2,
        description: null,
        kind: "page",
        title: "Hello",
        updatedAt: "2026-10-27T10:00:00.000Z",
        url: URL,
      },
    ];
    const result = await call(
      port({ list: () => Promise.resolve({ items, next: "c2" }) }),
      "artifact_list",
      { kind: "page" }
    );
    expect(result.structuredContent).toEqual({ items, next: "c2" });
    expect(textOf(result)).toContain("c2");
  });

  test("list says so when empty", async () => {
    const result = await call(
      port({ list: () => Promise.resolve({ items: [] }) }),
      "artifact_list",
      {}
    );
    expect(result.structuredContent).toEqual({ items: [] });
    expect(textOf(result)).toBe("No artifacts.");
  });
});

describe("artifact_test", () => {
  const report: ArtifactTestInfo = {
    consoleMessages: [
      { level: "error", text: "Refused to load script (CSP)" },
      { level: "warning", text: "deprecated" },
    ],
    failedRequests: [
      {
        status: 404,
        url: "https://app.example/a/x/c/hm_view_abc.def/missing.js",
      },
      { status: null, url: "https://cdn.example/x.js" },
    ],
    screenshotPath: "agents/ops/tasks/run_1/artifact-test.png",
    snapshot: "heading Hello",
    title: "Hello",
    version: 2,
  };

  test("returns text only: title, console, failed requests, snapshot, screenshot path", async () => {
    let received: unknown;
    const result = await call(
      port({
        test: (input) => {
          received = input;
          return Promise.resolve(report);
        },
      }),
      "artifact_test",
      { artifactId: ID, viewport: "phone" }
    );
    expect(received).toEqual({ artifactId: ID, viewport: "phone" });
    expect(result.isError).toBeFalsy();
    expect(result.content?.every((part) => part.type === "text")).toBe(true);
    const text = textOf(result);
    for (const needle of [
      "Title: Hello",
      "error: Refused to load script (CSP)",
      "warning: deprecated",
      "404 ",
      "no response https://cdn.example/x.js",
      "heading Hello",
      "agents/ops/tasks/run_1/artifact-test.png",
    ]) {
      expect(text).toContain(needle);
    }
  });

  test("never shows a view token, even inside a failed request URL", async () => {
    const result = await call(
      port({ test: () => Promise.resolve(report) }),
      "artifact_test",
      { artifactId: ID }
    );
    expect(JSON.stringify(result)).not.toContain("hm_view_abc");
    expect(textOf(result)).toContain("hm_view_[redacted]/missing.js");
  });

  test("a clean run says so", async () => {
    const result = await call(
      port({
        test: () =>
          Promise.resolve({
            ...report,
            consoleMessages: [],
            failedRequests: [],
          }),
      }),
      "artifact_test",
      { artifactId: ID }
    );
    expect(textOf(result)).toContain("No console errors or failed requests.");
  });
});

describe("app artifacts", () => {
  test("create takes the app kind and defaults the entry to index.html", async () => {
    let received: { entry?: string; kind?: string } = {};
    const result = await call(
      port({
        create: (input) => {
          received = input;
          return Promise.resolve(published);
        },
      }),
      "artifact_create",
      {
        files: [
          html,
          { path: "server/index.js", text: "export default {};" },
          { path: "harbourmaster.json", text: "{}" },
        ],
        kind: "app",
        title: "App",
      }
    );
    expect(result.isError).toBeFalsy();
    expect(received.kind).toBe("app");
    expect(received.entry).toBe("index.html");
  });
});

describe("artifact_promote", () => {
  test("forwards the version and says it is live", async () => {
    let received: unknown;
    const result = await call(
      port({
        promote: (input) => {
          received = input;
          return Promise.resolve({ status: "promoted", version: 3 });
        },
      }),
      "artifact_promote",
      { artifactId: ID, version: 3 }
    );
    expect(received).toEqual({ artifactId: ID, version: 3 });
    expect(textOf(result)).toBe("Version 3 is now live.");
  });

  test("a waiting version tells the agent to stop", async () => {
    const result = await call(
      port({
        promote: () => Promise.resolve({ status: "waiting", version: 2 }),
      }),
      "artifact_promote",
      { artifactId: ID }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Version 2 waits for a person");
    expect(textOf(result)).toContain("Needs you");
    expect(textOf(result)).toContain("do not retry");
  });

  test("dry run skips the promote and records it", async () => {
    const recorded: { summary: string; tool: string }[] = [];
    const result = await call(
      port(),
      "artifact_promote",
      { artifactId: ID },
      {
        dryRun: {
          record: (skip) => {
            recorded.push(skip);
            return Promise.resolve();
          },
        },
      }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toStartWith("Skipped in dry run: would ");
    expect(recorded.map((skip) => skip.tool)).toEqual(["artifact_promote"]);
  });
});

describe("live document creation", () => {
  test("document markdown uses only the live port and returns no extra credentials", async () => {
    const input = {
      description: "A plan",
      kind: "document",
      markdown: "# Plan",
      message: "Initial",
      title: "Plan",
    };
    const live = {
      comment: uncalled("live.comment"),
      comments: uncalled("live.comments"),
      create: (received: unknown) => {
        expect(received).toEqual(input);
        return Promise.resolve({
          artifactId: ID,
          revision: 0,
          secret: "hidden",
          url: URL,
        });
      },
      edit: uncalled("live.edit"),
      read: uncalled("live.read"),
    };
    const result = await callTool(
      fakePorts({ artifacts: port(), live }),
      "artifact_create",
      input
    );
    expect(result.structuredContent).toEqual({
      artifactId: ID,
      revision: 0,
      url: URL,
    });
    expect(textOf(result)).toContain("document_edit");
    expect(textOf(result)).not.toContain("hidden");
  });

  test("empty document is allowed and live create dry-runs never call either port", async () => {
    let creates = 0;
    const live = {
      comment: uncalled("live.comment"),
      comments: uncalled("live.comments"),
      create: () => {
        creates += 1;
        return Promise.resolve({ artifactId: ID, revision: 0, url: URL });
      },
      edit: uncalled("live.edit"),
      read: uncalled("live.read"),
    };
    const ports = fakePorts({ artifacts: port(), live });
    const input = { kind: "document", title: "Plan" };
    expect((await callTool(ports, "artifact_create", input)).isError).not.toBe(
      true
    );
    expect(creates).toBe(1);
    const result = await callTool(ports, "artifact_create", input, {
      dryRun: { record: async () => undefined },
    });
    expect(textOf(result)).toStartWith(
      "Skipped in dry run: would create an artifact"
    );
    expect(creates).toBe(1);
  });

  test("mixed static/live payloads and unavailable live creation fail clearly", async () => {
    await Promise.all(
      [
        { files: [html], kind: "document", title: "Plan" },
        { entry: "index.md", kind: "document", title: "Plan" },
        { fromLibraryPath: "tasks/a", kind: "document", title: "Plan" },
        { files: [html], kind: "page", markdown: "wrong", title: "Plan" },
      ].map(async (input) => {
        const result = await call(port(), "artifact_create", input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "validation" });
      })
    );
    const result = await call(port(), "artifact_create", {
      kind: "document",
      title: "Plan",
    });
    expect(textOf(result)).toContain("not available");
  });
});

test("artifact_update preserves the adapter's refusal to replace a live document", async () => {
  const result = await call(
    port({
      update: () =>
        Promise.reject(
          new ToolError("validation", "Use document_edit for a live document.")
        ),
    }),
    "artifact_update",
    { artifactId: ID, baseVersion: 1, files: [html] }
  );
  expect(result.structuredContent).toEqual({
    code: "validation",
    message: "Use document_edit for a live document.",
  });
});
