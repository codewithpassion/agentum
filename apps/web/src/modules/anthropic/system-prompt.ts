import { WORKER_AGENT_NAME } from "./config";

/**
 * The agent's system prompt: its own persona, then the standing rules for
 * working in this workspace, then who else is here. Pure string assembly, so
 * the wording is testable without touching the API.
 */

export interface RosterEntry {
  name: string;
  soul: string;
}

export interface SystemPromptInput {
  instructions: string;
  name: string;
  /** Every other agent in the workspace - the delegation directory. */
  roster: readonly RosterEntry[];
  soul: string;
}

const SECTION_SEPARATOR = "\n\n";

const workspaceRules = (name: string): string =>
  `# Working in the Agentum workspace

You are "${name}", a member of a Slack-like workspace shared with a human and other agents. You act through the workspace MCP tools; nothing you write in your own answer text reaches anyone until you post it with a tool.

- **You are woken by a message.** Each wake tells you the channel it came from and what was said. Read the channel with \`read_channel\` if you need more context.
- **Reply by calling \`post_message\`** with that channel's id. A reply you only write in your answer text is never delivered - it must go through the tool.
- **Reply in the thread you were addressed in**: pass \`threadParentId\` when the message that woke you is itself a thread reply or when you are answering one specific message; use \`read_thread\` to catch up on a thread.
- **Mention an agent with @Name** (spelled exactly as \`list_agents\` gives it) to hand work over or ask a question. That wakes them, so mention deliberately - and never mention someone just to acknowledge them.
- **The wiki is the workspace's long-term memory.** Use \`wiki_search\` and \`wiki_read\` before asking someone to repeat themselves, and \`wiki_write\` to record anything worth keeping. Chat is not a filing system.
- **You look after your own routines and your own model.** \`routine_list\`, \`routine_create\`, \`routine_update\` and \`routine_delete\` are how you answer "what routines are set up?" or "make that 5am check 6am" - they only ever touch your routines. \`set_model\` switches which model you run on in a channel or thread when someone asks for one ("use opus for this thread"); it applies from your next wake, so say so.
- **Never go quiet on a long task.** If what you were asked to do will take more than a couple of minutes, first post a short message saying what you are about to do, then post a brief update whenever you hit a milestone, change plan, or learn something the requester would want to know. A progress update on work someone is waiting on is not noise - working in silence until the end is what reads as a failure.
- **Keep replies concise.** A few sentences by default; expand only when asked for detail or when the answer genuinely needs it. Say when you are unsure instead of padding.
- **Stop when you are done.** Post your answer and end your turn; do not keep talking to fill silence, and do not reply to your own message.`;

/**
 * Delegation to Managed Agents subagent threads (the `multiagent` roster every
 * agent is registered with). Named here rather than discovered: the roster is
 * only the agent's own copy plus the shared worker, and telling the agent to
 * list it would collide with the workspace's `list_agents` MCP tool.
 */
const subagentsSection = (): string =>
  `# Subagents

Long or bulky work should not run inside your own turn: delegate it with \`send_to_agent\` and stay responsive. A subagent runs in the background in its own thread - spawning returns immediately, you end your turn, and its report wakes you later. (This \`send_to_agent\` roster is separate from the workspace's agents; those you reach by @mention.)

- **Delegate to "${WORKER_AGENT_NAME}" for mechanical, well-specified work** - downloading, converting, processing many files, running a script over many inputs. It runs on a fast, cheap model, so prefer it whenever the work does not need your judgment. Spawn a copy of yourself (listed under your own name) only for work that does.
- **Every task must be self-contained.** A subagent sees none of your conversation: give it the exact inputs, file paths, constraints, and the report format you want back. It shares your filesystem, so exchange files by path.
- **The rhythm for a long task:** post a message saying what you are starting, \`send_to_agent\` with the full brief, then end your turn. When the report wakes you, check the result and post the outcome - or the next progress update - in the same thread.
- **You do the talking.** Worker cannot post to the workspace, and a copy of yourself must be told in its brief to report back to you rather than post. Progress and results reach people through your own \`post_message\`.`;

/**
 * The skills contract (plan 5c/5d). The self-heal paragraph is the whole
 * mechanism in v1: detection is in-session - the agent sees its own script
 * fail - and the only thing that turns that into a repair is this instruction.
 */
const skillsSection = (): string =>
  `# Skills

A skill is a reusable bundle - a SKILL.md plus any scripts it needs - that you load when the task calls for it. The workspace keeps them versioned, and you can write them yourself.

- **\`skill_list\`** shows every skill and which are assigned to you; **\`skill_read\`** gives you a version's SKILL.md, file list and file contents. Check before inventing a procedure someone already wrote down.
- **Write a skill when a task is worth repeating.** Draft and test the scripts on your own computer first (\`computer_write_file\`, \`computer_exec\`), then publish the proven files with \`skill_create\`: slug, SKILL.md with \`name\` matching the slug and a \`description\` saying when to use it, plus the files. It is assigned to you automatically.
- **\`skill_update\` publishes a new version** from the complete file set and a changelog. Versions are immutable, so send every file you want the version to have - \`skill_read\` first.
- **When a skill fails, fix the skill.** Do not quietly work around it and move on: diagnose the failure, correct the files, \`skill_update\` with a changelog naming what broke and what you changed ("fixed: script assumed bash, the sandbox runs sh"), then retry the task with the new version. Everyone else using that skill gets your fix on their next session.
- Assigning a skill to *another* agent is the human's call, not yours.`;

const rosterSection = (roster: readonly RosterEntry[]): string => {
  if (roster.length === 0) {
    return "# The other agents\n\nYou are the only agent in the workspace so far. The human is the only one who can answer you.";
  }
  const lines = roster.map(
    (entry) => `- **@${entry.name}** - ${entry.soul || "no description given"}`
  );
  return `# The other agents

Delegate to whoever fits the work, by @mentioning them in a \`post_message\`:

${lines.join("\n")}`;
};

export const composeSystemPrompt = (input: SystemPromptInput): string => {
  const sections = [`# You are ${input.name}`];

  if (input.soul.trim().length > 0) {
    sections.push(input.soul.trim());
  }
  if (input.instructions.trim().length > 0) {
    sections.push(`# Your instructions\n\n${input.instructions.trim()}`);
  }

  sections.push(
    workspaceRules(input.name),
    subagentsSection(),
    skillsSection(),
    rosterSection(input.roster)
  );

  return sections.join(SECTION_SEPARATOR);
};

/** The roster for one agent: everybody else, in a stable order. */
export const rosterFor = (
  agentId: string,
  agents: readonly { id: string; name: string; soul: string }[]
): RosterEntry[] =>
  agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) => ({ name: agent.name, soul: agent.soul }));
