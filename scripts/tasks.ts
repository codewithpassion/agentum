// Lists docs/tasks/*.md with their status and marks the ready ones with "*".
// Exits 1 on an unknown status or a dependency on a task that does not exist.
import { readTasks } from "./task-files";

const STATUSES = new Set(["todo", "in_progress", "review", "done", "blocked"]);

const tasks = await readTasks(new URL("..", import.meta.url).pathname);
const byId = new Map(tasks.map((task) => [task.id, task]));
const errors: string[] = [];
const lines: string[] = [];

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
