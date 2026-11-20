import type { TaskView } from "#/integrations/trpc/types";
import type { TaskListItem } from "./now-logic.ts";

type Event = TaskView["events"][number];

/** The moment the fixtures treat as now: midday on the viewer's 20 November 2026. */
export const NOW_MS = new Date(2026, 10, 20, 12, 0, 0).getTime();
export const TODAY_ISO = new Date(2026, 10, 20, 9, 0, 0).toISOString();
export const YESTERDAY_ISO = new Date(2026, 10, 19, 9, 0, 0).toISOString();

export const makeEvent = (overrides: Partial<Event>): Event =>
  ({
    actor: { id: "agent_1", kind: "agent" },
    agentId: "agent_1",
    createdAt: TODAY_ISO,
    id: "e01",
    payload: {},
    payloadRef: null,
    runId: "run_1",
    seq: null,
    sessionId: "ses_1",
    type: "message.assistant",
    workspaceId: "ws_1",
    ...overrides,
  }) as Event;

export const makeListItem = (
  overrides: Partial<TaskListItem>
): TaskListItem => ({
  agentId: "agent_1",
  createdAt: TODAY_ISO,
  finishedAt: null,
  helper: false,
  id: "run_1",
  sessionId: "ses_1",
  status: "running",
  statusBand: { text: "Working", tone: "running" },
  title: "Reconcile the invoices",
  ...overrides,
});

/** A running task with a tool call under way and two subagents, one working and one done. */
export const makeTask = (overrides: Partial<TaskView> = {}): TaskView =>
  ({
    agent: {
      computerMachineId: null,
      id: "agent_1",
      machine: null,
      name: "Sorter",
      runtime: "fake",
    },
    children: [],
    events: [
      makeEvent({
        id: "e01",
        payload: { origin: "ui" },
        type: "run.queued",
      }),
      makeEvent({
        id: "e02",
        payload: {
          input: { query: "overdue" },
          name: "search_invoices",
          toolUseId: "t1",
        },
        type: "tool.call",
      }),
    ],
    eventsTruncated: false,
    otherRuns: [],
    parent: null,
    request: null,
    run: {
      costUsd: null,
      createdAt: TODAY_ISO,
      finishedAt: null,
      id: "run_1",
      inputText: "Reconcile the invoices",
      startedAt: TODAY_ISO,
      status: "running",
    },
    session: {
      archivedAt: null,
      externalKey: null,
      id: "ses_1",
      origin: "ui",
      parentSessionId: null,
      pinnedAt: null,
      title: "Reconcile the invoices",
    },
    startedBy: { kind: "person", label: "Dom" },
    subagents: [
      {
        id: "run_2",
        model: "sonnet",
        status: "running",
        title: "Read the bank export",
      },
      {
        id: "run_3",
        model: "sonnet",
        status: "waiting",
        title: "Draft the reminders",
      },
      {
        id: "run_4",
        model: "haiku",
        status: "done",
        title: "Count the receipts",
      },
    ],
    title: "Reconcile the invoices",
    ...overrides,
  }) as TaskView;
