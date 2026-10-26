import { describe, expect, test } from "bun:test";
import {
  computerInstructions,
  extractAttachmentMarkers,
  stripAttachmentMarkers,
  type WorkspaceInstructionsInput,
  workspaceInstructions,
} from "./attachments.ts";

describe("stripAttachmentMarkers", () => {
  test("returns text unchanged when there is no marker", () => {
    const text = "plain reply\n\nwith   spacing ";
    expect(stripAttachmentMarkers(text)).toBe(text);
  });

  test("removes a marker at the end of a line", () => {
    expect(stripAttachmentMarkers("Here [ATTACHMENT:/w/report.md]")).toBe(
      "Here"
    );
  });

  test("removes an inline marker and its preceding space", () => {
    expect(stripAttachmentMarkers("a [ATTACHMENT:x] b")).toBe("a b");
  });

  test("tidies whitespace left by markers on their own line", () => {
    const text =
      "Here it is [ATTACHMENT:x.png] ok\n[ATTACHMENT:y.png]\n\n\n\nDone  \n";
    expect(stripAttachmentMarkers(text)).toBe("Here it is ok\n\nDone");
  });
});

describe("extractAttachmentMarkers", () => {
  test("returns text unchanged when there is no marker", () => {
    const text = "plain reply\n\nwith   spacing ";
    expect(extractAttachmentMarkers(text)).toEqual({ paths: [], text });
  });

  test("collects paths in order and de-duplicates them", () => {
    const result = extractAttachmentMarkers(
      "[ATTACHMENT:a.png] and [ATTACHMENT:b.txt] then [ATTACHMENT:a.png]"
    );
    expect(result.paths).toEqual(["a.png", "b.txt"]);
  });

  test("keeps spaces inside a path and trims the edges", () => {
    const result = extractAttachmentMarkers(
      "see [ATTACHMENT:  my docs/report 1.pdf ]"
    );
    expect(result.paths).toEqual(["my docs/report 1.pdf"]);
  });

  test("removes markers and tidies the text around them", () => {
    const text =
      "Here it is [ATTACHMENT:x.png] ok\n[ATTACHMENT:y.png]\n\n\n\nDone  \n";
    expect(extractAttachmentMarkers(text).text).toBe("Here it is ok\n\nDone");
  });
});

describe("workspaceInstructions", () => {
  const vm: WorkspaceInstructionsInput = {
    home: "/workspace/home",
    homeIsLocal: true,
    library: null,
    scratch: {
      lasts: "vm-sleep",
      path: "/tmp and anything else outside /workspace/home",
    },
  };
  const isolate: WorkspaceInstructionsInput = {
    home: "/library/agents/support/",
    homeIsLocal: true,
    library: "/library",
    scratch: { lasts: "call", path: null },
  };
  const managed: WorkspaceInstructionsInput = {
    home: "agents/support/",
    homeIsLocal: false,
    library: null,
    scratch: { lasts: "session", path: null },
  };
  const machine: WorkspaceInstructionsInput = {
    home: "/home/dom/agents/support",
    homeIsLocal: true,
    library: null,
    scratch: { lasts: "run-start", path: "./tmp" },
  };

  test("names a local or library task folder instead of asking for markers", () => {
    for (const [input, taskFolder] of [
      [vm, "/workspace/library/agents/support/tasks/task-1/"],
      [managed, "agents/support/tasks/task-1/"],
    ] as const) {
      for (const attachments of [undefined, false, true]) {
        const text = workspaceInstructions({
          ...input,
          attachments,
          taskFolder,
        });
        expect(text).toContain(
          `Save files for the user in ${taskFolder}. Everything there shows in the task's Files panel.`
        );
        expect(text).not.toContain("[ATTACHMENT:");
        expect(text).not.toContain("on its own line in your final answer");
      }
    }
  });

  test("names each synced root's access mode and prefers roots over legacy paths", () => {
    const text = workspaceInstructions({
      ...isolate,
      roots: [
        { mode: "write", path: "agents/support" },
        { mode: "read", path: "shared/brand" },
      ],
      syncedPaths: ["legacy/path"],
    });
    expect(text).toContain(
      "holds a synced copy of agents/support (write), shared/brand (read) from the workspace library."
    );
    expect(text).not.toContain("legacy/path");
    expect(text).toContain("Your changes go back to it when your run ends.");
    expect(text).toContain("saved next to it as <file>.conflict-<runId>");
  });

  test("live sync describes changes going back within seconds for either root input", () => {
    for (const paths of [
      { roots: [{ mode: "write" as const, path: "agents/support" }] },
      { syncedPaths: ["agents/support"] },
    ]) {
      const text = workspaceInstructions({
        ...isolate,
        ...paths,
        liveSync: true,
      });
      expect(text).toContain("Your changes go back to it within seconds.");
      expect(text).not.toContain("when your run ends");
    }
  });

  test("empty roots fall back to legacy synced paths", () => {
    const input = { ...isolate, syncedPaths: ["agents/support"] };
    expect(workspaceInstructions({ ...input, roots: [] })).toBe(
      workspaceInstructions(input)
    );
    expect(workspaceInstructions({ ...isolate, roots: [] })).toBe(
      workspaceInstructions(isolate)
    );
    expect(workspaceInstructions({ ...input, liveSync: false })).toBe(
      workspaceInstructions(input)
    );
  });

  test("names root modes for a library reached through tools", () => {
    const text = workspaceInstructions({
      ...managed,
      roots: [{ mode: "read", path: "shared/brand" }],
    });
    expect(text).toContain("shared/brand (read)");
    expect(text).toContain("reach it with the library tools");
    expect(text).not.toContain("synced copy");
  });

  test("VM: home is cwd, scratch vanishes on sleep, library is tools only", () => {
    const text = workspaceInstructions(vm);
    expect(text).toContain("- Home: /workspace/home.");
    expect(text).toContain("Relative paths start here");
    expect(text).toContain("deleted when the VM sleeps");
    expect(text).toContain("never keep anything there that you need later");
    expect(text).toContain("reach it with the library tools");
    expect(text).toContain("[ATTACHMENT:<absolute path>]");
  });

  test("isolate: home and library are local paths and scratch is per call", () => {
    const text = workspaceInstructions(isolate);
    expect(text).toContain("- Home: /library/agents/support/.");
    expect(text).toContain("- Library: /library.");
    expect(text).toContain("no scratch folder");
    expect(text).toContain("outside home and the library");
    expect(text).toContain("kept for one tool call only");
    expect(text).not.toContain("library tools");
  });

  test("managed: home is a library folder reached with the library tools", () => {
    const text = workspaceInstructions(managed);
    expect(text).toContain("the library folder agents/support/");
    expect(text).toContain("not a folder on your disk");
    expect(text).toContain("deleted when this session ends");
  });

  test("machine: scratch is a folder emptied before each run", () => {
    const text = workspaceInstructions(machine);
    expect(text).toContain("- Home: /home/dom/agents/support.");
    expect(text).toContain("- Scratch: ./tmp.");
    expect(text).toContain("emptied before your next run");
  });

  test("never prints /library when the library is not local", () => {
    for (const input of [vm, managed, machine]) {
      expect(workspaceInstructions(input)).not.toContain("/library");
    }
  });

  test("describes a synced library folder with its paths and conflict rule", () => {
    const text = workspaceInstructions({
      ...isolate,
      syncedPaths: ["agents/ada", "shared/brand"],
    });
    expect(text).toContain(
      "- Library: /library holds a synced copy of agents/ada, shared/brand from the workspace library."
    );
    expect(text).toContain("saved next to it as <file>.conflict-<runId>");
    expect(text).toContain("reach it with the library tools");
  });

  test("keeps the library line unchanged without synced paths", () => {
    const unchanged =
      "- Library: /library. It is shared with every agent and person in this workspace and kept for good. Put finished work that people or other agents should see there.";
    expect(workspaceInstructions(isolate)).toContain(unchanged);
    expect(workspaceInstructions({ ...isolate, syncedPaths: [] })).toContain(
      unchanged
    );
  });

  test("lists conflict copies under a local library path", () => {
    const text = workspaceInstructions({
      ...isolate,
      conflicts: ["agents/ada/notes.md"],
    });
    expect(text).toContain(
      "- Conflicts: some changes could not be saved because the library file changed first."
    );
    expect(text).toContain("delete the copy: /library/agents/ada/notes.md.");
    expect(text.indexOf("- Conflicts:")).toBeGreaterThan(
      text.indexOf("- Library:")
    );
  });

  test("lists conflict copies as bare library paths when library is null", () => {
    const text = workspaceInstructions({
      ...managed,
      conflicts: ["shared/brand/guide.md", "agents/support/plan.md"],
    });
    expect(text).toContain("- Conflicts: some changes could not be saved");
    expect(text).toContain(
      "delete the copy: shared/brand/guide.md, agents/support/plan.md."
    );
    expect(text).not.toContain("/library");
  });

  test("adds no conflicts line when the list is empty or absent", () => {
    expect(workspaceInstructions({ ...isolate, conflicts: [] })).not.toContain(
      "Conflicts:"
    );
    expect(workspaceInstructions(isolate)).not.toContain("Conflicts:");
  });

  test("leaves the attachment line out when the runtime reads no markers", () => {
    const text = workspaceInstructions({ ...managed, attachments: false });
    expect(text).not.toContain("[ATTACHMENT:");
    expect(text).toContain("- Library:");
  });

  test("names all three areas and the attachment line once", () => {
    for (const input of [vm, isolate, managed, machine]) {
      const text = workspaceInstructions(input);
      expect(text).toContain("- Home:");
      expect(text).toContain("- Scratch:");
      expect(text).toContain("- Library:");
      expect(text.match(/\[ATTACHMENT:/g)).toHaveLength(1);
    }
  });

  test("omits the run_script paragraph by default and when runScript is false", () => {
    for (const input of [vm, isolate, managed, machine]) {
      expect(workspaceInstructions(input)).not.toContain("run_script");
      expect(workspaceInstructions({ ...input, runScript: false })).toBe(
        workspaceInstructions(input)
      );
    }
  });

  test("ends with the run_script paragraph after a blank line when runScript is true", () => {
    const paragraph =
      "You have no shell runtime such as node, bun or python. To run JavaScript or TypeScript, use `run_script` with a library file or inline code. Scripts can read and write the library and, when network access is on, use fetch. npm packages and Node built-ins such as fs and child_process aren't available. For work that needs them, ask for this agent to use the Linux VM.";
    expect(workspaceInstructions({ ...isolate, runScript: true })).toBe(
      `${workspaceInstructions(isolate)}\n\n${paragraph}`
    );
  });
});

describe("computerInstructions", () => {
  test("file and shell guidance without desktop", () => {
    const text = computerInstructions({ desktop: false });
    expect(text).toContain("computer_exec");
    expect(text).toContain("computer_edit_file");
    expect(text).toContain("scratch machine");
    expect(text).not.toContain(":99");
    expect(text).not.toContain("request_human_takeover");
  });
  test("desktop display, background launch, screenshot and runtime takeover guidance", () => {
    const text = computerInstructions({ desktop: true });
    for (const part of [
      ":99",
      "DISPLAY",
      "background",
      "xterm &",
      "desktop_screenshot",
      "request_human_takeover",
      "CAPTCHA",
    ]) {
      expect(text).toContain(part);
    }
    expect(text.split("request_human_takeover")).toHaveLength(2);
  });
});
