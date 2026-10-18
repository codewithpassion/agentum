import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  type Extension,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createFakeVm } from "./linux-vm/fake-vm.ts";
import {
  FILES_EXTENSION,
  filesExtension,
  inputContent,
  type RunFilesPort,
  uploadOutputs,
  uploadVmOutputs,
} from "./pi-run-files.ts";

interface Entry {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

const NO_API = {} as ToolExecutionApi;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};
const TEXT_BYTES = new TextEncoder().encode("hello from the file");
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const MB = 1024 * 1024;

interface FakeOptions {
  failDownload?: string[];
  failUpload?: string[];
  files?: Record<string, Entry>;
  library?: Record<string, Uint8Array>;
  throwLibrary?: string[];
}

/** A port over in-memory maps. `uploads` records what was sent, in order. */
const fakePort = (options: FakeOptions = {}) => {
  const files = options.files ?? {};
  const library = options.library ?? {};
  const uploads: Entry[] = [];
  const port: RunFilesPort & { uploads: Entry[] } = {
    download: (fileId) => {
      const entry = files[fileId];
      if (entry === undefined || options.failDownload?.includes(fileId)) {
        return Promise.reject(new Error(`no file ${fileId}`));
      }
      return Promise.resolve(entry);
    },
    readLibrary: (path) => {
      if (options.throwLibrary?.includes(path)) {
        return Promise.reject(new Error("storage down"));
      }
      return Promise.resolve(library[path] ?? null);
    },
    upload: (file) => {
      if (options.failUpload?.includes(file.name)) {
        return Promise.reject(new Error("upload refused"));
      }
      uploads.push(file);
      return Promise.resolve({ id: `up-${uploads.length}` });
    },
    uploads,
  };
  return port;
};

/** Pulls one tool out of an extension, failing the test when it is missing. */
const toolNamed = (extension: Extension, name: string): ToolRegistration => {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return tool;
};

const runReadTool = (
  readInput: (fileId: string) => Promise<Entry>,
  id: string
) =>
  toolNamed(filesExtension(readInput), "read_input_file").execute(
    { id },
    NO_API,
    CONTEXT
  );

describe("inputContent", () => {
  test("no file ids returns the text unchanged", async () => {
    expect(await inputContent("hi", [], fakePort())).toBe("hi");
  });

  test("an image becomes an image block with the same base64 as Buffer", async () => {
    const bytes = Uint8Array.from(
      { length: 100_000 },
      (_, i) => (i * 31 + Math.floor(i / 256)) % 256
    );
    const port = fakePort({
      files: { img: { bytes, mime: "image/png", name: "big.png" } },
    });
    const content = await inputContent("look", ["img"], port);
    expect(content).toEqual([
      {
        text: "look\n\nFiles attached to this message:\n- big.png (image/png, shown as an image below)",
        type: "text",
      },
      {
        data: Buffer.from(bytes).toString("base64"),
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  test("a non-image is listed with the read hint when it is text", async () => {
    const port = fakePort({
      files: {
        f1: {
          bytes: TEXT_BYTES,
          mime: "text/plain",
          name: "notes.txt",
        },
        f2: { bytes: PNG, mime: "application/pdf", name: "spec.pdf" },
      },
    });
    expect(await inputContent("task", ["f1", "f2"], port)).toEqual([
      {
        text: [
          "task",
          "",
          "Files attached to this message:",
          "- notes.txt (text/plain, id f1): read it with read_input_file",
          "- spec.pdf (application/pdf, id f2)",
        ].join("\n"),
        type: "text",
      },
    ]);
  });

  test("a file that fails to download is listed as unreadable and does not throw", async () => {
    const port = fakePort({
      failDownload: ["gone"],
      files: { ok: { bytes: PNG, mime: "image/png", name: "a.png" } },
    });
    const content = await inputContent("task", ["gone", "ok"], port);
    expect(content).toEqual([
      {
        text: "task\n\nFiles attached to this message:\n- gone (could not be read)\n- a.png (image/png, shown as an image below)",
        type: "text",
      },
      {
        data: Buffer.from(PNG).toString("base64"),
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  test("images past the total size budget are listed, not sent as blocks", async () => {
    const port = fakePort({
      files: {
        a: {
          bytes: new Uint8Array(700_000),
          mime: "image/jpeg",
          name: "a.jpg",
        },
        b: {
          bytes: new Uint8Array(700_000),
          mime: "image/jpeg",
          name: "b.jpg",
        },
      },
    });
    const content = await inputContent("task", ["a", "b"], port);
    expect(content).toHaveLength(2);
    expect(content[1]).toMatchObject({ mimeType: "image/jpeg", type: "image" });
    expect(content[0]).toEqual({
      text: "task\n\nFiles attached to this message:\n- a.jpg (image/jpeg, shown as an image below)\n- b.jpg (image/jpeg, id b)",
      type: "text",
    });
  });
});

describe("uploadOutputs", () => {
  test("text without a marker comes back untouched", async () => {
    const port = fakePort();
    expect(await uploadOutputs("plain answer", port)).toEqual({
      fileIds: [],
      text: "plain answer",
    });
    expect(port.uploads).toEqual([]);
  });

  test("a /library/ path and a relative path are uploaded, in order", async () => {
    const port = fakePort({
      library: {
        "b.csv": TEXT_BYTES,
        "reports/a.png": PNG,
      },
    });
    const result = await uploadOutputs(
      "Done.\n[ATTACHMENT:/library/reports/a.png]\n[ATTACHMENT:./b.csv]",
      port
    );
    expect(result).toEqual({
      fileIds: ["up-1", "up-2"],
      text: "Done.",
    });
    expect(port.uploads.map((file) => [file.name, file.mime])).toEqual([
      ["a.png", "image/png"],
      ["b.csv", "text/csv"],
    ]);
  });

  test("absolute paths outside the library and parent segments are refused", async () => {
    const port = fakePort({ library: { "x.txt": TEXT_BYTES } });
    const result = await uploadOutputs(
      "[ATTACHMENT:/etc/passwd] and [ATTACHMENT:/library/../secret.txt] [ATTACHMENT:../up.txt]",
      port
    );
    expect(result.fileIds).toEqual([]);
    expect(result.text).toBe(
      [
        "and",
        "[attachment refused: passwd]",
        "[attachment refused: secret.txt]",
        "[attachment refused: up.txt]",
      ].join("\n")
    );
    expect(port.uploads).toEqual([]);
  });

  test("a missing library file gives a missing note", async () => {
    const port = fakePort();
    expect(await uploadOutputs("See [ATTACHMENT:out/none.pdf]", port)).toEqual({
      fileIds: [],
      text: "See\n[attachment missing: none.pdf]",
    });
  });

  test("a file over 50 MB is refused", async () => {
    const port = fakePort({
      library: { "big.zip": new Uint8Array(50 * MB + 1) },
    });
    expect(await uploadOutputs("[ATTACHMENT:big.zip]", port)).toEqual({
      fileIds: [],
      text: "[attachment refused: big.zip]",
    });
  });

  test("a read that throws and an upload that throws leave notes, and the other file still goes", async () => {
    const port = fakePort({
      failUpload: ["bad.txt"],
      library: {
        "bad.txt": TEXT_BYTES,
        "boom.txt": TEXT_BYTES,
        "good.txt": TEXT_BYTES,
      },
      throwLibrary: ["boom.txt"],
    });
    const result = await uploadOutputs(
      "[ATTACHMENT:bad.txt] [ATTACHMENT:boom.txt] [ATTACHMENT:good.txt]",
      port
    );
    expect(result).toEqual({
      fileIds: ["up-1"],
      text: "[attachment failed: bad.txt]\n[attachment failed: boom.txt]",
    });
    expect(port.uploads.map((file) => file.name)).toEqual(["good.txt"]);
  });

  test("a relative marker is read from the agent's home, an absolute one from the library root", async () => {
    const port = fakePort({
      library: {
        "agents/ada/a.txt": PNG,
        "agents/ada/b.txt": PNG,
        "c.txt": PNG,
      },
    });
    const result = await uploadOutputs(
      "[ATTACHMENT:a.txt] [ATTACHMENT:./b.txt] [ATTACHMENT:/library/c.txt]",
      port,
      "agents/ada"
    );
    expect(result.fileIds).toHaveLength(3);
    expect(port.uploads.map((file) => file.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  test("the mime comes from the extension, with a fallback", async () => {
    const names = ["a.PDF", "b.docx", "c.mp4", "d.unknown", "noext"];
    const port = fakePort({
      library: Object.fromEntries(names.map((name) => [name, PNG])),
    });
    await uploadOutputs(
      names.map((name) => `[ATTACHMENT:${name}]`).join(" "),
      port
    );
    expect(port.uploads.map((file) => file.mime)).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "video/mp4",
      "application/octet-stream",
      "application/octet-stream",
    ]);
  });
});

describe("filesExtension", () => {
  const extension = filesExtension(async () => ({
    bytes: TEXT_BYTES,
    mime: "text/plain",
    name: "x.txt",
  }));

  test("is named for the files, offers read_input_file and has no prompt section", () => {
    expect(extension.name).toBe(FILES_EXTENSION);
    expect(extension.tools?.map((tool) => tool.name)).toEqual([
      "read_input_file",
    ]);
    expect(extension.sections).toBeUndefined();
  });

  test("read_input_file returns the text of a text file", async () => {
    expect(
      await runReadTool(
        async () => ({ bytes: TEXT_BYTES, mime: "text/plain", name: "n.txt" }),
        "f"
      )
    ).toEqual({
      isError: false,
      output: [{ text: "hello from the file", type: "text" }],
    });
  });

  test("read_input_file cuts a long text file and says so", async () => {
    const long = "a".repeat(100_005);
    const result = await runReadTool(
      async () => ({
        bytes: new TextEncoder().encode(long),
        mime: "application/json",
        name: "long.json",
      }),
      "f"
    );
    expect(result.isError).toBe(false);
    expect(result.output).toEqual([
      { text: `${"a".repeat(100_000)}\n[truncated]`, type: "text" },
    ]);
  });

  test("read_input_file refuses a binary file", async () => {
    expect(
      await runReadTool(
        async () => ({ bytes: PNG, mime: "image/png", name: "p.png" }),
        "f"
      )
    ).toEqual({
      isError: true,
      output: [
        {
          text: "p.png is a image/png file and cannot be read as text",
          type: "text",
        },
      ],
    });
  });

  test("read_input_file reports a read that throws", async () => {
    expect(
      await runReadTool(() => Promise.reject(new Error("nope")), "f9")
    ).toEqual({
      isError: true,
      output: [{ text: "File f9 could not be read", type: "text" }],
    });
  });
});

describe("read_input_file through a real harness", () => {
  const textOf = (content: Message["content"] | undefined): string => {
    if (content === undefined) {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((part) =>
        "text" in part && typeof part.text === "string" ? part.text : ""
      )
      .join("");
  };

  /** Calls read_input_file for file-1, then repeats what the tool result said. */
  const script = (context: TranscriptContext): AssistantMessage => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText(`saw:${textOf(last.content)}`)]);
    }
    return fauxAssistantMessage(
      [fauxToolCall("read_input_file", { id: "file-1" })],
      {
        stopReason: "toolUse",
      }
    );
  };

  test("the model receives the text that read_input_file returns", async () => {
    const faux = fauxProvider();
    faux.setResponses([script, script]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      filesExtension(async () => ({
        bytes: TEXT_BYTES,
        mime: "text/plain",
        name: "notes.txt",
      }))
    );

    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT
    );
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { modelId: faux.getModel().id, provider: faux.provider.id },
      },
    });
    const submission = await root.submit(
      { content: "read the file", type: "input" },
      BACKGROUND_CONTEXT
    );
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    if (settled.status !== "done") {
      throw new Error(`the run did not finish: ${settled.status}`);
    }
    const page = await root.entries(
      { order: "ascending" },
      50,
      undefined,
      BACKGROUND_CONTEXT
    );
    await harness.close(BACKGROUND_CONTEXT);
    const toolResult = page.items
      .map((entry) => entry.model?.[0])
      .find((message) => message?.role === "toolResult");
    expect(textOf(toolResult?.content)).toBe("hello from the file");
  });
});

describe("uploadOutputs count", () => {
  test("at most 100 files go out and the rest are refused", async () => {
    const library: Record<string, Uint8Array> = {};
    const markers: string[] = [];
    for (let n = 0; n < 101; n += 1) {
      library[`f${n}.txt`] = new Uint8Array(1);
      markers.push(`[ATTACHMENT:/library/f${n}.txt]`);
    }
    const result = await uploadOutputs(
      markers.join("\n"),
      fakePort({ library })
    );
    expect(result.fileIds).toHaveLength(100);
    expect(result.text).toBe("[attachment refused: f100.txt]");
  });
});

describe("uploadVmOutputs", () => {
  const HOME = "/workspace/home";
  const SCRATCH = "/tmp";

  /** A fake VM with the given files, and /tmp present. */
  const vmWith = (files: Record<string, Uint8Array>) => {
    const vm = createFakeVm();
    vm.folders.add(SCRATCH);
    for (const [path, bytes] of Object.entries(files)) {
      vm.files.set(path, bytes);
    }
    return vm;
  };

  test("a home file is read by absolute path and by relative path", async () => {
    const vm = vmWith({ [`${HOME}/report.txt`]: TEXT_BYTES });
    const port = fakePort();
    expect(
      await uploadVmOutputs(
        "[ATTACHMENT:/workspace/home/report.txt] [ATTACHMENT:report.txt] [ATTACHMENT:./report.txt]",
        vm,
        port
      )
    ).toEqual({ fileIds: ["up-1", "up-2", "up-3"], text: "" });
    expect(port.uploads).toEqual([
      { bytes: TEXT_BYTES, mime: "text/plain", name: "report.txt" },
      { bytes: TEXT_BYTES, mime: "text/plain", name: "report.txt" },
      { bytes: TEXT_BYTES, mime: "text/plain", name: "report.txt" },
    ]);
  });

  test("a scratch file in /tmp is uploaded as image/png", async () => {
    const vm = vmWith({ [`${SCRATCH}/out.png`]: PNG });
    const port = fakePort();
    expect(
      await uploadVmOutputs("Chart: [ATTACHMENT:/tmp/out.png]", vm, port)
    ).toEqual({ fileIds: ["up-1"], text: "Chart:" });
    expect(port.uploads).toEqual([
      { bytes: PNG, mime: "image/png", name: "out.png" },
    ]);
  });

  test("paths outside the allowed roots and parent segments are refused, and nothing is uploaded", async () => {
    const vm = vmWith({
      "/etc/passwd": TEXT_BYTES,
      "/library/b.txt": TEXT_BYTES,
      "/workspace/../etc/shadow": TEXT_BYTES,
      "/workspace/up.txt": TEXT_BYTES,
      "/workspacex/a.txt": TEXT_BYTES,
    });
    const port = fakePort();
    expect(
      await uploadVmOutputs(
        "Result: [ATTACHMENT:/etc/passwd] [ATTACHMENT:/workspacex/a.txt] [ATTACHMENT:/library/b.txt] [ATTACHMENT:/workspace/../etc/shadow] [ATTACHMENT:../up.txt]",
        vm,
        port
      )
    ).toEqual({
      fileIds: [],
      text: [
        "Result:",
        "[attachment refused: passwd]",
        "[attachment refused: a.txt]",
        "[attachment refused: b.txt]",
        "[attachment refused: shadow]",
        "[attachment refused: up.txt]",
      ].join("\n"),
    });
    expect(port.uploads).toEqual([]);
  });

  test("a missing file gives a missing note", async () => {
    const port = fakePort();
    expect(
      await uploadVmOutputs(
        "See [ATTACHMENT:nothere.txt]",
        createFakeVm(),
        port
      )
    ).toEqual({
      fileIds: [],
      text: "See\n[attachment missing: nothere.txt]",
    });
  });

  test("a folder marker gives a missing note", async () => {
    const vm = vmWith({});
    vm.folders.add(`${HOME}/notes`);
    const port = fakePort();
    expect(await uploadVmOutputs("[ATTACHMENT:notes]", vm, port)).toEqual({
      fileIds: [],
      text: "[attachment missing: notes]",
    });
    expect(port.uploads).toEqual([]);
  });

  test("a file over 50 MB is refused", async () => {
    const vm = vmWith({ [`${SCRATCH}/big.bin`]: new Uint8Array(50 * MB + 1) });
    const port = fakePort();
    expect(
      await uploadVmOutputs("[ATTACHMENT:/tmp/big.bin]", vm, port)
    ).toEqual({ fileIds: [], text: "[attachment refused: big.bin]" });
    expect(port.uploads).toEqual([]);
  });

  test("text without markers comes back untouched", async () => {
    const port = fakePort();
    expect(await uploadVmOutputs("plain answer", createFakeVm(), port)).toEqual(
      { fileIds: [], text: "plain answer" }
    );
    expect(port.uploads).toEqual([]);
  });

  test("one bad marker does not stop a good one, and ids keep marker order", async () => {
    const vm = vmWith({
      [`${SCRATCH}/out.png`]: PNG,
      [`${HOME}/report.txt`]: TEXT_BYTES,
    });
    const port = fakePort();
    expect(
      await uploadVmOutputs(
        "[ATTACHMENT:missing.txt] [ATTACHMENT:/tmp/out.png] [ATTACHMENT:/etc/passwd] [ATTACHMENT:report.txt]",
        vm,
        port
      )
    ).toEqual({
      fileIds: ["up-1", "up-2"],
      text: [
        "[attachment missing: missing.txt]",
        "[attachment refused: passwd]",
      ].join("\n"),
    });
    expect(port.uploads.map((file) => file.name)).toEqual([
      "out.png",
      "report.txt",
    ]);
  });
});
