// Removes the worktrees, temp dirs and branches of tasks that are done.
// Worktrees live in ../harbourmaster-wt next to the main checkout: <id> for a
// dispatcher, review-<id>-<sha> for a reviewer, tmp/<id> for logs and scratch.
// A worktree with uncommitted changes, or a branch not merged into main, is kept.
import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { $ } from "bun";
import { readTasks } from "./task-files";

const gitDir =
  await $`git rev-parse --path-format=absolute --git-common-dir`.text();
const repoRoot = dirname(gitDir.trim());
const wtRoot = resolve(repoRoot, "../harbourmaster-wt");
const done = new Set(
  (await readTasks(repoRoot))
    .filter((task) => task.status === "done")
    .map((task) => task.id)
);
const out: string[] = [];

const PREFIX = /^(review-|task\/)/;
const listDir = (path: string) => readdir(path).catch(() => [] as string[]);
// "M0.2", "review-M0.2-1a2b3c4" and "task/M0.2-schema" all name task M0.2.
const taskId = (name: string) => name.replace(PREFIX, "").split("-")[0] ?? "";

for (const name of await listDir(wtRoot)) {
  if (name === "tmp" || !done.has(taskId(name))) {
    continue;
  }
  const path = `${wtRoot}/${name}`;
  // biome-ignore lint/performance/noAwaitInLoops: git locks the repo, so removals run one at a time
  const result = await $`git -C ${repoRoot} worktree remove ${path}`
    .quiet()
    .nothrow();
  out.push(
    result.exitCode === 0
      ? `removed worktree ${name}`
      : `kept worktree ${name}: ${result.stderr.toString().trim()}`
  );
}

const doneTmp = (await listDir(`${wtRoot}/tmp`)).filter((name) =>
  done.has(name)
);
await Promise.all(
  doneTmp.map((name) =>
    rm(`${wtRoot}/tmp/${name}`, { force: true, recursive: true })
  )
);
out.push(...doneTmp.map((name) => `removed tmp/${name}`));

await $`git -C ${repoRoot} worktree prune`.quiet();

const branches =
  await $`git -C ${repoRoot} branch --list ${"task/*"} --format=${"%(refname:short)"}`.text();
for (const branch of branches.split("\n").filter(Boolean)) {
  if (!done.has(taskId(branch))) {
    continue;
  }
  // biome-ignore lint/performance/noAwaitInLoops: git locks the repo, so deletions run one at a time
  const result = await $`git -C ${repoRoot} branch -d ${branch}`
    .quiet()
    .nothrow();
  out.push(
    result.exitCode === 0
      ? `deleted branch ${branch}`
      : `kept branch ${branch}: ${result.stderr.toString().trim()}`
  );
}

const tmpEmpty = (await listDir(`${wtRoot}/tmp`)).length === 0;
const left = (await listDir(wtRoot)).filter(
  (name) => !(name === "tmp" && tmpEmpty)
);
if (left.length > 0) {
  const size = await $`du -sh ${wtRoot}`.quiet().text();
  out.push(`left in ${wtRoot}: ${left.join(", ")} (${size.split("\t")[0]})`);
}
process.stdout.write(
  `${out.length > 0 ? out.join("\n") : "nothing to clean"}\n`
);
