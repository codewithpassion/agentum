import { describe, expect, test } from "bun:test";
import type { SkillSummary, SkillsPort } from "../pi-run-skills.ts";
import { bytesOf, createFakeVm, textOf } from "./fake-vm.ts";
import { placeInputFiles, placeSkills, withPlacedPaths } from "./vm-workdir.ts";

const SKILLS = "/workspace/skills";
const INPUT = "/workspace/input";

const portOf = (
  contents: Map<string, string>,
  unreadable: readonly string[] = [],
  executable: readonly string[] = []
): SkillsPort => ({
  list: () =>
    Promise.resolve(
      [...contents.keys()].map((path) => ({
        executable: executable.includes(path),
        path,
      }))
    ),
  read: (path) => {
    const text = contents.get(path);
    if (text === undefined || unreadable.includes(path)) {
      return Promise.reject(new Error(`cannot read ${path}`));
    }
    return Promise.resolve(bytesOf(text));
  },
});

const shout: SkillSummary = {
  description: "Shouts",
  files: ["shout/scripts/hello.ts", "shout/notes/a.md"],
  name: "shout",
};

const shoutContents = (): Map<string, string> =>
  new Map([
    ["shout/SKILL.md", "---\nname: shout\n---\nShout things."],
    ["shout/scripts/hello.ts", "console.log('hi');"],
    ["shout/notes/a.md", "a note"],
  ]);

describe("placeSkills", () => {
  test("writes SKILL.md and nested skill files at their paths with their bytes", async () => {
    const vm = createFakeVm();
    await placeSkills(vm, [shout], portOf(shoutContents()));

    expect(textOf(vm.files.get(`${SKILLS}/shout/SKILL.md`))).toBe(
      "---\nname: shout\n---\nShout things."
    );
    expect(textOf(vm.files.get(`${SKILLS}/shout/scripts/hello.ts`))).toBe(
      "console.log('hi');"
    );
    expect(textOf(vm.files.get(`${SKILLS}/shout/notes/a.md`))).toBe("a note");
    expect(vm.folders.has(`${SKILLS}/shout/scripts`)).toBe(true);
    expect(vm.folders.has(`${SKILLS}/shout/notes`)).toBe(true);
  });

  test("removes the folder of a skill that is no longer listed", async () => {
    const vm = createFakeVm();
    vm.folders.add(SKILLS);
    vm.folders.add(`${SKILLS}/old`);
    vm.files.set(`${SKILLS}/old/SKILL.md`, bytesOf("old"));

    await placeSkills(vm, [shout], portOf(shoutContents()));

    expect(vm.files.has(`${SKILLS}/old/SKILL.md`)).toBe(false);
    expect(vm.folders.has(`${SKILLS}/old`)).toBe(false);
    expect(vm.files.has(`${SKILLS}/shout/SKILL.md`)).toBe(true);
  });

  test("skips an unreadable file, places the rest, then throws an error naming it", async () => {
    const vm = createFakeVm();
    const port = portOf(shoutContents(), ["shout/scripts/hello.ts"]);

    await expect(placeSkills(vm, [shout], port)).rejects.toThrow(
      "shout/scripts/hello.ts"
    );

    expect(vm.files.has(`${SKILLS}/shout/SKILL.md`)).toBe(true);
    expect(vm.files.has(`${SKILLS}/shout/notes/a.md`)).toBe(true);
    expect(vm.files.has(`${SKILLS}/shout/scripts/hello.ts`)).toBe(false);
  });

  test("sets the executable flag on flagged files in one command", async () => {
    const vm = createFakeVm();
    const flagged = ["shout/scripts/hello.ts", "shout/SKILL.md"];
    const executable: SkillSummary = { ...shout, executable: flagged };

    await placeSkills(vm, [executable], portOf(shoutContents(), [], flagged));

    expect(vm.execCalls).toEqual([
      {
        command: `chmod +x -- '${SKILLS}/shout/scripts/hello.ts' '${SKILLS}/shout/SKILL.md'`,
        cwd: "/workspace",
        maxOutputBytes: 4096,
        timeoutMs: 30_000,
      },
    ]);
  });

  test("quotes a path with a single quote for the shell", async () => {
    const vm = createFakeVm();
    const contents = new Map([
      ["odd/SKILL.md", "---\nname: odd\n---\nOdd."],
      ["odd/it's.sh", "echo"],
    ]);
    const odd: SkillSummary = {
      description: "Odd",
      executable: ["odd/it's.sh"],
      files: ["odd/it's.sh"],
      name: "odd",
    };

    await placeSkills(vm, [odd], portOf(contents, [], ["odd/it's.sh"]));

    expect(vm.execCalls[0]?.command).toBe(
      `chmod +x -- '${SKILLS}/odd/it'\\''s.sh'`
    );
  });

  test("runs no command when no file is flagged", async () => {
    const vm = createFakeVm();

    await placeSkills(vm, [shout], portOf(shoutContents()));

    expect(vm.execCalls).toEqual([]);
  });

  test("throws with the stderr when the chmod fails", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 1,
      stderr: "chmod: cannot access 'x': No such file or directory",
      stdout: "",
      timedOut: false,
      truncated: false,
    });
    const flagged = ["shout/scripts/hello.ts"];

    await expect(
      placeSkills(
        vm,
        [{ ...shout, executable: flagged }],
        portOf(shoutContents(), [], flagged)
      )
    ).rejects.toThrow(
      "Could not set the executable flag on skill files: chmod: cannot access 'x': No such file or directory"
    );
  });

  test("throws when the chmod times out", async () => {
    const vm = createFakeVm();
    vm.onExec = () => ({
      exitCode: 124,
      stderr: "",
      stdout: "",
      timedOut: true,
      truncated: false,
    });
    const flagged = ["shout/scripts/hello.ts"];

    await expect(
      placeSkills(
        vm,
        [{ ...shout, executable: flagged }],
        portOf(shoutContents(), [], flagged)
      )
    ).rejects.toThrow("Could not set the executable flag on skill files");
  });

  test("creates the skills folder when there are no skills", async () => {
    const vm = createFakeVm();

    await placeSkills(vm, [], portOf(new Map()));

    expect(vm.folders.has(SKILLS)).toBe(true);
    expect(vm.files.size).toBe(0);
  });
});

describe("placeInputFiles", () => {
  test("writes each file and returns the paths in the given order", async () => {
    const vm = createFakeVm();

    const paths = await placeInputFiles(vm, [
      { bytes: bytesOf("first"), name: "one.txt" },
      { bytes: bytesOf("second"), name: "dir/two.csv" },
    ]);

    expect(paths).toEqual([`${INPUT}/one.txt`, `${INPUT}/two.csv`]);
    expect(textOf(vm.files.get(`${INPUT}/one.txt`))).toBe("first");
    expect(textOf(vm.files.get(`${INPUT}/two.csv`))).toBe("second");
  });

  test("keeps the files of earlier runs in the folder", async () => {
    const vm = createFakeVm();
    vm.folders.add(INPUT);
    vm.files.set(`${INPUT}/old.txt`, bytesOf("old"));

    await placeInputFiles(vm, [{ bytes: bytesOf("new"), name: "new.txt" }]);

    expect(textOf(vm.files.get(`${INPUT}/old.txt`))).toBe("old");
    expect(textOf(vm.files.get(`${INPUT}/new.txt`))).toBe("new");
  });

  test("renames duplicate names before the extension", async () => {
    const vm = createFakeVm();

    const paths = await placeInputFiles(vm, [
      { bytes: bytesOf("1"), name: "a.txt" },
      { bytes: bytesOf("2"), name: "a.txt" },
      { bytes: bytesOf("3"), name: "a.txt" },
      { bytes: bytesOf("4"), name: "b" },
      { bytes: bytesOf("5"), name: "b" },
    ]);

    expect(paths).toEqual([
      `${INPUT}/a.txt`,
      `${INPUT}/a-2.txt`,
      `${INPUT}/a-3.txt`,
      `${INPUT}/b`,
      `${INPUT}/b-2`,
    ]);
    expect(textOf(vm.files.get(`${INPUT}/a-2.txt`))).toBe("2");
  });

  test("does not reuse a name that a renamed file already took", async () => {
    const vm = createFakeVm();

    const paths = await placeInputFiles(vm, [
      { bytes: bytesOf("1"), name: "a.txt" },
      { bytes: bytesOf("2"), name: "a-2.txt" },
      { bytes: bytesOf("3"), name: "a.txt" },
    ]);

    expect(paths).toEqual([
      `${INPUT}/a.txt`,
      `${INPUT}/a-2.txt`,
      `${INPUT}/a-3.txt`,
    ]);
  });

  test("keeps hostile names inside the input folder", async () => {
    const vm = createFakeVm();

    const paths = await placeInputFiles(vm, [
      { bytes: bytesOf("1"), name: "../../etc/passwd" },
      { bytes: bytesOf("2"), name: "dir/" },
      { bytes: bytesOf("3"), name: ".." },
      { bytes: bytesOf("4"), name: "." },
      { bytes: bytesOf("5"), name: "" },
      { bytes: bytesOf("6"), name: "/" },
      { bytes: bytesOf("7"), name: "x\0y.txt" },
      { bytes: bytesOf("8"), name: ".env" },
    ]);

    expect(paths).toEqual([
      `${INPUT}/passwd`,
      `${INPUT}/file`,
      `${INPUT}/file-2`,
      `${INPUT}/file-3`,
      `${INPUT}/file-4`,
      `${INPUT}/file-5`,
      `${INPUT}/xy.txt`,
      `${INPUT}/.env`,
    ]);
    for (const path of paths) {
      expect(path.startsWith(`${INPUT}/`)).toBe(true);
      expect(path.slice(INPUT.length + 1)).not.toContain("/");
    }
  });

  test("returns no paths and keeps the folder when there are no files", async () => {
    const vm = createFakeVm();

    const paths = await placeInputFiles(vm, []);

    expect(paths).toEqual([]);
    expect(vm.folders.has(INPUT)).toBe(true);
    expect(vm.files.size).toBe(0);
  });
});

describe("withPlacedPaths", () => {
  test("adds the paths to a text message", () => {
    expect(withPlacedPaths("hello", ["/workspace/input/a.txt"])).toBe(
      "hello\n\nThe attached files are also in the Linux VM at: /workspace/input/a.txt"
    );
  });

  test("adds the paths to the first text block only and leaves images alone", () => {
    const image = { data: "x", mimeType: "image/png", type: "image" } as const;
    const result = withPlacedPaths(
      [{ text: "see", type: "text" }, image, { text: "more", type: "text" }],
      ["/workspace/input/a.png", "/workspace/input/b.txt"]
    );
    expect(result).toEqual([
      {
        text: "see\n\nThe attached files are also in the Linux VM at: /workspace/input/a.png, /workspace/input/b.txt",
        type: "text",
      },
      image,
      { text: "more", type: "text" },
    ]);
  });

  test("changes nothing when no file was placed", () => {
    expect(withPlacedPaths("hello", [])).toBe("hello");
  });
});
