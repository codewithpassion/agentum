// Lists docs/tasks/*.md with their status and marks the ready ones with "*".
// Exits 1 on an unknown status or a dependency on a task that does not exist.
import { Glob, file as readFile, YAML } from "bun";

interface Task {
  depends_on: string[];
  id: string;
  status: string;
  title: string;
}

const STATUSES = new Set(["todo", "in_progress", "review", "done", "blocked"]);
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const dir = new URL("../docs/tasks/", import.meta.url).pathname;

const tasks: Task[] = [];
for await (const name of new Glob("*.md").scan(dir)) {
  const match = FRONTMATTER.exec(await readFile(dir + name).text());
  if (!match?.[1]) {
    throw new Error(`${name}: no frontmatter`);
  }
  tasks.push(YAML.parse(match[1]) as Task);
}

const byId = new Map(tasks.map((task) => [task.id, task]));
const errors: string[] = [];
const lines: string[] = [];

tasks.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
for (const task of tasks) {
  if (!STATUSES.has(task.status)) {
    errors.push(`${task.id}: unknown status ${task.status}`);
  }
  for (const dep of task.depends_on) {
    if (!byId.has(dep)) {
      errors.push(`${task.id}: unknown dependency ${dep}`);
    }
  }
  const ready =
    task.status === "todo" &&
    task.depends_on.every((dep) => byId.get(dep)?.status === "done");
  lines.push(
    `${ready ? "*" : " "} ${task.id.padEnd(6)} ${task.status.padEnd(11)} ${task.title}`
  );
}

process.stdout.write(`${lines.join("\n")}\n`);
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
