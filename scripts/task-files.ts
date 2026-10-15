// Reads the frontmatter of every task file in docs/tasks/.
import { Glob, file as readFile, YAML } from "bun";

export interface Task {
  depends_on: string[];
  id: string;
  status: string;
  title: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

export async function readTasks(repoRoot: string): Promise<Task[]> {
  const dir = `${repoRoot}/docs/tasks/`;
  const tasks: Task[] = [];
  for await (const name of new Glob("*.md").scan(dir)) {
    const match = FRONTMATTER.exec(await readFile(dir + name).text());
    if (!match?.[1]) {
      throw new Error(`${name}: no frontmatter`);
    }
    tasks.push(YAML.parse(match[1]) as Task);
  }
  return tasks.sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true })
  );
}
