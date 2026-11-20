import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  DREAM_SCHEDULES,
  LEARN_LEVELS,
  MEMORY_CHANGE_STATUSES,
  MEMORY_NOTE_KINDS,
  MEMORY_NOTE_MAX_CHARS,
  MEMORY_SOURCE_KINDS,
  type MemoryChange,
  type MemoryNote,
  type MemoryRules,
  type RememberRules,
} from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { readableWorkspace } from "../guards.ts";
import type { Principal } from "../workspaces.ts";

const MEMORY_READ = "memory.read";
const MEMORY_WRITE = "memory.write";
const MEMORY_RULES_WRITE = "memory.rules.write";
const MEMORY_KIND = "memory";

const MAX_RULE_ENTRIES = 50;
const MAX_RULE_CHARS = 200;

const agentIdSchema = z.string().min(1);
const noteKindSchema = z.enum(MEMORY_NOTE_KINDS);
const WHITESPACE_RUN = /\s+/g;
// A note is one line: line breaks and runs of whitespace become one space
// before the length is counted.
const noteTextSchema = z
  .string()
  .transform((text) => text.replace(WHITESPACE_RUN, " ").trim())
  .pipe(z.string().min(1).max(MEMORY_NOTE_MAX_CHARS));
const sourceSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(MEMORY_SOURCE_KINDS),
});
const ruleListSchema = z
  .array(z.string().trim().min(1).max(MAX_RULE_CHARS))
  .max(MAX_RULE_ENTRIES);

export const rememberRulesSchema = z.strictObject({
  dreamSchedule: z.enum(DREAM_SCHEDULES),
  learnLevel: z.enum(LEARN_LEVELS),
  never: ruleListSchema,
  remember: ruleListSchema,
  shareWithTeam: z.boolean(),
});

export const listInputSchema = z.strictObject({
  agentId: agentIdSchema,
  kind: noteKindSchema.optional(),
});

/** The writer is the principal: a user adds as `person`, a run as `agent`. */
export const addInputSchema = z.strictObject({
  agentId: agentIdSchema,
  kind: noteKindSchema,
  source: sourceSchema.optional(),
  text: noteTextSchema,
});

export const editInputSchema = z.strictObject({
  agentId: agentIdSchema,
  noteId: z.string().min(1),
  text: noteTextSchema,
});

export const forgetInputSchema = z.strictObject({
  agentId: agentIdSchema,
  noteId: z.string().min(1),
});

export const decideInputSchema = z.strictObject({
  changeId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

export const undoInputSchema = z.strictObject({
  changeId: z.string().min(1),
});

export const changesInputSchema = z.strictObject({
  agentId: agentIdSchema,
  // ISO 8601 UTC. Only changes made at or after it.
  since: z.string().min(1).optional(),
  status: z.enum(MEMORY_CHANGE_STATUSES).optional(),
});

export const rulesGetInputSchema = z.strictObject({
  agentId: agentIdSchema,
});

export const rulesSetInputSchema = z.strictObject({
  agentId: agentIdSchema,
  rules: rememberRulesSchema,
});

export type RulesGetInput = z.infer<typeof rulesGetInputSchema>;
export type AddNoteInput = z.infer<typeof addInputSchema>;
export type EditNoteInput = z.infer<typeof editInputSchema>;
export type ForgetNoteInput = z.infer<typeof forgetInputSchema>;
export type DecideChangeInput = z.infer<typeof decideInputSchema>;
export type ChangesInput = z.infer<typeof changesInputSchema>;
export type ListNotesInput = z.infer<typeof listInputSchema>;
export type SetRulesInput = z.infer<typeof rulesSetInputSchema>;

const memoryResource = (workspaceId: string, id?: string) => ({
  id,
  kind: MEMORY_KIND,
  workspaceId,
});

const notFound = (what: string): Promise<never> =>
  Promise.reject(new ServiceError("not_found", `No ${what}`));

const defaultRules = (): MemoryRules => ({
  agent: structuredClone<RememberRules>(DEFAULT_REMEMBER_RULES),
  workspaceNever: [...DEFAULT_NEVER_REMEMBER],
});

/**
 * Stub: no agent has notes or changes, every write finds nothing to change,
 * and the rules are the defaults. The memory service task fills these from the
 * library files and the `memory_changes` table, and is then the only writer of
 * `agents/<slug>/memory/`.
 */
export const createMemoryService = () => {
  const list = (
    principal: Principal,
    input: ListNotesInput
  ): Promise<MemoryNote[]> => {
    const workspaceId = readableWorkspace(principal, MEMORY_READ);
    authorize(
      principal,
      MEMORY_READ,
      memoryResource(workspaceId, input.agentId)
    );
    return Promise.resolve([]);
  };

  const add = (
    principal: Principal,
    input: AddNoteInput
  ): Promise<MemoryChange> => {
    const workspaceId = readableWorkspace(principal, MEMORY_WRITE);
    authorize(
      principal,
      MEMORY_WRITE,
      memoryResource(workspaceId, input.agentId)
    );
    return notFound(`agent "${input.agentId}"`);
  };

  const edit = (
    principal: Principal,
    input: EditNoteInput
  ): Promise<MemoryChange> => {
    const workspaceId = readableWorkspace(principal, MEMORY_WRITE);
    authorize(
      principal,
      MEMORY_WRITE,
      memoryResource(workspaceId, input.agentId)
    );
    return notFound(`note "${input.noteId}"`);
  };

  const forget = (
    principal: Principal,
    input: ForgetNoteInput
  ): Promise<MemoryChange> => {
    const workspaceId = readableWorkspace(principal, MEMORY_WRITE);
    authorize(
      principal,
      MEMORY_WRITE,
      memoryResource(workspaceId, input.agentId)
    );
    return notFound(`note "${input.noteId}"`);
  };

  const decide = (
    principal: Principal,
    input: DecideChangeInput
  ): Promise<MemoryChange> => {
    const workspaceId = readableWorkspace(principal, MEMORY_WRITE);
    authorize(
      principal,
      MEMORY_WRITE,
      memoryResource(workspaceId, input.changeId)
    );
    return notFound(`change "${input.changeId}"`);
  };

  const undo = (
    principal: Principal,
    changeId: string
  ): Promise<MemoryChange> => {
    const workspaceId = readableWorkspace(principal, MEMORY_WRITE);
    authorize(principal, MEMORY_WRITE, memoryResource(workspaceId, changeId));
    return notFound(`change "${changeId}"`);
  };

  const changes = (
    principal: Principal,
    input: ChangesInput
  ): Promise<MemoryChange[]> => {
    const workspaceId = readableWorkspace(principal, MEMORY_READ);
    authorize(
      principal,
      MEMORY_READ,
      memoryResource(workspaceId, input.agentId)
    );
    return Promise.resolve([]);
  };

  const rules = {
    get: (principal: Principal, input: RulesGetInput): Promise<MemoryRules> => {
      const workspaceId = readableWorkspace(principal, MEMORY_READ);
      authorize(
        principal,
        MEMORY_READ,
        memoryResource(workspaceId, input.agentId)
      );
      return Promise.resolve(defaultRules());
    },
    set: (principal: Principal, input: SetRulesInput): Promise<MemoryRules> => {
      const workspaceId = readableWorkspace(principal, MEMORY_RULES_WRITE);
      authorize(
        principal,
        MEMORY_RULES_WRITE,
        memoryResource(workspaceId, input.agentId)
      );
      return notFound(`agent "${input.agentId}"`);
    },
  };

  return { add, changes, decide, edit, forget, list, rules, undo };
};

export type MemoryService = ReturnType<typeof createMemoryService>;
