import type {
  MemoryChange,
  MemoryNote,
  MemoryNoteKind,
  MemoryRules,
  RememberRules,
} from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { weekStartIso } from "./learned-logic.ts";

/** What the Knows tab reads from the memory router. */
export interface MemoryData {
  /** Applied changes of the last seven days, newest first. */
  changes: MemoryChange[];
  /** Changes waiting for a person. */
  held: MemoryChange[];
  notes: MemoryNote[];
  /** The moment the data was read, for "today" and "yesterday". */
  nowMs: number;
  rules: MemoryRules;
}

/** The memory of one agent and the actions that change it. Every action reloads the data when it ends. */
export interface MemoryApi {
  add: (kind: MemoryNoteKind, text: string) => void;
  adding: boolean;
  /** The note or change an action is working on. */
  busyId: string | null;
  data: MemoryData | undefined;
  decide: (changeId: string, decision: "approve" | "reject") => void;
  edit: (noteId: string, text: string) => void;
  error: string | undefined;
  forget: (noteId: string) => void;
  /** Reads the notes, changes and rules again, for a change made elsewhere on the tab. */
  reload: () => Promise<void>;
  saving: boolean;
  setRules: (rules: RememberRules) => void;
  undo: (changeId: string) => void;
}

const loadMemory = async (agentId: string): Promise<MemoryData> => {
  const trpc = getTrpc();
  const nowMs = Date.now();
  const [notes, held, changes, rules] = await Promise.all([
    trpc.memory.list.query({ agentId }),
    trpc.memory.changes.query({ agentId, status: "held" }),
    trpc.memory.changes.query({ agentId, since: weekStartIso(nowMs) }),
    trpc.memory.rules.get.query({ agentId }),
  ]);
  return { changes, held, notes, nowMs, rules };
};

export function useMemory(agentId: string): MemoryApi {
  const [data, setData] = useState<MemoryData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  // The agent the data on screen belongs to, so a slow reply for another agent is dropped.
  const current = useRef(agentId);
  current.current = agentId;

  const reload = useCallback(async () => {
    try {
      const next = await loadMemory(agentId);
      if (current.current === agentId) {
        setData(next);
      }
    } catch (cause) {
      if (current.current === agentId) {
        setError(errorMessage(cause));
      }
    }
  }, [agentId]);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    reload();
  }, [reload]);

  /** Runs one change, shows why it failed, and reloads either way. */
  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      setError(undefined);
      try {
        await change();
      } catch (cause) {
        setError(errorMessage(cause));
      }
      await reload();
    },
    [reload]
  );

  const add = useCallback(
    async (kind: MemoryNoteKind, text: string) => {
      setAdding(true);
      await run(() => getTrpc().memory.add.mutate({ agentId, kind, text }));
      setAdding(false);
    },
    [agentId, run]
  );

  const edit = useCallback(
    async (noteId: string, text: string) => {
      setBusyId(noteId);
      await run(() => getTrpc().memory.edit.mutate({ agentId, noteId, text }));
      setBusyId(null);
    },
    [agentId, run]
  );

  const forget = useCallback(
    async (noteId: string) => {
      setBusyId(noteId);
      await run(() => getTrpc().memory.forget.mutate({ agentId, noteId }));
      setBusyId(null);
    },
    [agentId, run]
  );

  const decide = useCallback(
    async (changeId: string, decision: "approve" | "reject") => {
      setBusyId(changeId);
      await run(() => getTrpc().memory.decide.mutate({ changeId, decision }));
      setBusyId(null);
    },
    [run]
  );

  const undo = useCallback(
    async (changeId: string) => {
      setBusyId(changeId);
      await run(() => getTrpc().memory.undo.mutate({ changeId }));
      setBusyId(null);
    },
    [run]
  );

  const setRules = useCallback(
    async (rules: RememberRules) => {
      setSaving(true);
      await run(() => getTrpc().memory.rules.set.mutate({ agentId, rules }));
      setSaving(false);
    },
    [agentId, run]
  );

  return {
    add,
    adding,
    busyId,
    data,
    decide,
    edit,
    error,
    forget,
    reload,
    saving,
    setRules,
    undo,
  };
}
