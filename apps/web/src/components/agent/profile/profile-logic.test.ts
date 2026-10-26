import { describe, expect, test } from "bun:test";
import {
  addressText,
  channelChips,
  folderLabel,
  handsToChips,
  LIBRARY_NOTE,
  receivesFromText,
  runtimeWords,
  skillChips,
  startChips,
  statusText,
  toolChips,
} from "./profile-logic.ts";

type Header = Parameters<typeof statusText>[0];
type Tools = Parameters<typeof toolChips>[0];
type Starts = Parameters<typeof startChips>[0];
type Channels = Parameters<typeof channelChips>[0];
type AgentRefs = Parameters<typeof handsToChips>[0];

const header = (overrides: Partial<Header> = {}): Header => ({
  emailLocal: null,
  id: "agent_1",
  machine: null,
  model: "claude",
  name: "Sorter",
  runtime: "cloud",
  slug: "sorter",
  status: "active",
  waitingRun: null,
  ...overrides,
});

const noTools: Tools = { connectors: [], secrets: [] };
const noStarts: Starts = { routines: [], slackMention: null, triggers: [] };

describe("runtimeWords", () => {
  test("names the machine it runs on", () => {
    expect(runtimeWords("machine", { name: "laptop" })).toBe("Runs on laptop");
  });

  test("falls back when a machine agent has no machine", () => {
    expect(runtimeWords("machine", null)).toBe("Runs on a machine");
  });

  test("names the other runtimes", () => {
    expect(runtimeWords("cloud", null)).toBe("Runs on Cloudflare");
    expect(runtimeWords("managed", null)).toBe("Runs on Anthropic cloud");
    expect(runtimeWords("fake", null)).toBe("Runs on a test runner");
  });
});

describe("statusText", () => {
  test("a run waiting on a person shows the last four characters of its id", () => {
    expect(
      statusText(
        header({
          waitingRun: {
            createdAt: "2026-10-01T00:00:00Z",
            runId: "run_0123456789ab",
            sessionId: "sess_1",
          },
        })
      )
    ).toEqual({ label: "Paused on task #89ab", runId: "run_0123456789ab" });
  });

  test("a waiting run wins over the archived and draft labels", () => {
    expect(
      statusText(
        header({
          status: "archived",
          waitingRun: {
            createdAt: "2026-10-01T00:00:00Z",
            runId: "run_xyz9",
            sessionId: "sess_1",
          },
        })
      )
    ).toEqual({ label: "Paused on task #xyz9", runId: "run_xyz9" });
  });

  test("an archived agent is archived", () => {
    expect(statusText(header({ status: "archived" }))).toEqual({
      label: "Archived",
      runId: null,
    });
  });

  test("a draft is a draft", () => {
    expect(statusText(header({ status: "draft" }))).toEqual({
      label: "Draft",
      runId: null,
    });
  });

  test("an active agent with nothing waiting has no status text", () => {
    expect(statusText(header())).toBeNull();
  });
});

describe("toolChips", () => {
  test("empty when the agent has no connectors or secrets", () => {
    expect(toolChips(noTools)).toEqual([]);
  });

  test("a connector with every tool is a plain chip", () => {
    expect(
      toolChips({
        connectors: [
          {
            allowedTools: null,
            connectorId: "c1",
            name: "Xero",
            status: "active",
            toolCount: 12,
          },
        ],
        secrets: [],
      })
    ).toEqual([{ key: "connector:c1", label: "Xero", tone: "default" }]);
  });

  test("a connector limited to some tools names how many", () => {
    expect(
      toolChips({
        connectors: [
          {
            allowedTools: ["list_bills", "create_bill"],
            connectorId: "c1",
            name: "Xero",
            status: "active",
            toolCount: 12,
          },
        ],
        secrets: [],
      })
    ).toEqual([
      {
        key: "connector:c1",
        label: "Xero · 2 of 12 tools",
        tone: "default",
      },
    ]);
  });

  test("a connector that is not active is a warning", () => {
    expect(
      toolChips({
        connectors: [
          {
            allowedTools: null,
            connectorId: "c2",
            name: "Gmail",
            status: "needs_auth",
            toolCount: 4,
          },
        ],
        secrets: [],
      })
    ).toEqual([{ key: "connector:c2", label: "Gmail", tone: "warn" }]);
  });

  test("secrets are listed as hidden and never show a value", () => {
    expect(
      toolChips({
        connectors: [],
        secrets: [{ id: "s1", mode: "env", name: "API_KEY" }],
      })
    ).toEqual([
      { key: "secret:s1", label: "API_KEY · hidden", tone: "default" },
    ]);
  });

  test("connectors come before secrets", () => {
    const chips = toolChips({
      connectors: [
        {
          allowedTools: null,
          connectorId: "c1",
          name: "Xero",
          status: "active",
          toolCount: 1,
        },
      ],
      secrets: [{ id: "s1", mode: "proxy", name: "TOKEN" }],
    });
    expect(chips.map((chip) => chip.key)).toEqual([
      "connector:c1",
      "secret:s1",
    ]);
  });
});

describe("skillChips", () => {
  test("empty when there are no skills", () => {
    expect(skillChips([])).toEqual([]);
  });

  test("a pinned skill shows its version, an unpinned one only its name", () => {
    expect(
      skillChips([
        {
          name: "Invoices",
          pinnedVersion: 3,
          proposedVersion: null,
          skillId: "k1",
        },
        {
          name: "Drafts",
          pinnedVersion: null,
          proposedVersion: null,
          skillId: "k2",
        },
      ])
    ).toEqual([
      { key: "skill:k1", label: "Invoices v3", tone: "default" },
      { key: "skill:k2", label: "Drafts", tone: "default" },
    ]);
  });

  test("a proposed version gets a warn chip right after its skill", () => {
    expect(
      skillChips([
        {
          name: "Invoices",
          pinnedVersion: 3,
          proposedVersion: 4,
          skillId: "k1",
        },
        {
          name: "Drafts",
          pinnedVersion: null,
          proposedVersion: null,
          skillId: "k2",
        },
      ])
    ).toEqual([
      { key: "skill:k1", label: "Invoices v3", tone: "default" },
      { key: "skill:k1:proposed", label: "Invoices v4 proposed", tone: "warn" },
      { key: "skill:k2", label: "Drafts", tone: "default" },
    ]);
  });

  test("a proposed version on an unpinned skill", () => {
    expect(
      skillChips([
        {
          name: "Drafts",
          pinnedVersion: null,
          proposedVersion: 1,
          skillId: "k2",
        },
      ])
    ).toEqual([
      { key: "skill:k2", label: "Drafts", tone: "default" },
      { key: "skill:k2:proposed", label: "Drafts v1 proposed", tone: "warn" },
    ]);
  });
});

describe("handsToChips and receivesFromText", () => {
  const sorter: AgentRefs[number] = {
    id: "a2",
    name: "Writer",
    slug: "writer",
  };
  const other: AgentRefs[number] = {
    id: "a3",
    name: "Checker",
    slug: "checker",
  };

  test("hands-to chips are one per agent, keyed by id", () => {
    expect(handsToChips([sorter, other])).toEqual([
      { key: "agent:a2", label: "Writer", tone: "default" },
      { key: "agent:a3", label: "Checker", tone: "default" },
    ]);
  });

  test("no hands-to agents gives no chips", () => {
    expect(handsToChips([])).toEqual([]);
  });

  test("receives-from text names every sender", () => {
    expect(receivesFromText([sorter, other])).toBe(
      "Receives from Writer, Checker"
    );
  });

  test("receives-from text is null when nobody sends work", () => {
    expect(receivesFromText([])).toBeNull();
  });
});

describe("startChips", () => {
  test("empty when nothing starts the agent", () => {
    expect(startChips(noStarts)).toEqual([]);
  });

  test("triggers, routines and a Slack mention in that order", () => {
    expect(
      startChips({
        routines: [
          {
            cron: "0 9 * * 1",
            id: "r1",
            lastFiredAt: null,
            name: "Weekly",
            nextRunAt: null,
            paused: false,
            timezone: "UTC",
          },
        ],
        slackMention: {
          id: "app1",
          listenMode: "mentions",
          status: "installed",
        },
        triggers: [
          { id: "t1", lastFiredAt: null, name: "New invoice", paused: false },
        ],
      })
    ).toEqual([
      { key: "trigger:t1", label: "New invoice", tone: "default" },
      {
        key: "routine:r1",
        label: "every Monday at 09:00 UTC",
        tone: "default",
      },
      { key: "slack", label: "Slack mention", tone: "default" },
    ]);
  });

  test("a paused routine and a paused trigger say so", () => {
    expect(
      startChips({
        routines: [
          {
            cron: "0 9 * * 1",
            id: "r1",
            lastFiredAt: null,
            name: "Weekly",
            nextRunAt: null,
            paused: true,
            timezone: "UTC",
          },
        ],
        slackMention: null,
        triggers: [
          { id: "t1", lastFiredAt: null, name: "New invoice", paused: true },
        ],
      })
    ).toEqual([
      { key: "trigger:t1", label: "New invoice · paused", tone: "default" },
      {
        key: "routine:r1",
        label: "every Monday at 09:00 UTC · paused",
        tone: "default",
      },
    ]);
  });
});

describe("channelChips", () => {
  const noSlack: Channels = { email: "reserved", slack: null };
  const slackWith = (
    status: "created" | "installed" | "revoked"
  ): Channels => ({
    email: "reserved",
    slack: { id: "app1", listenMode: "mentions", status },
  });

  test("no Slack app and no email address", () => {
    expect(channelChips(noSlack, null)).toEqual([
      { key: "slack", label: "Slack · not set up", tone: "default" },
      { key: "email", label: "Email · no address yet", tone: "default" },
      { key: "whatsapp", label: "WhatsApp (later)", tone: "default" },
    ]);
  });

  test("an installed Slack app and an email address are on", () => {
    expect(channelChips(slackWith("installed"), "robo")).toEqual([
      { key: "slack", label: "Slack app", tone: "on" },
      { key: "email", label: "Email", tone: "on" },
      { key: "whatsapp", label: "WhatsApp (later)", tone: "default" },
    ]);
  });

  test("a created Slack app is not installed yet", () => {
    expect(channelChips(slackWith("created"), null)[0]).toEqual({
      key: "slack",
      label: "Slack app · not installed",
      tone: "default",
    });
  });

  test("a revoked Slack app is a warning", () => {
    expect(channelChips(slackWith("revoked"), null)[0]).toEqual({
      key: "slack",
      label: "Slack app · revoked",
      tone: "warn",
    });
  });
});

describe("folderLabel", () => {
  test("the home folder says so", () => {
    expect(folderLabel({ access: "read_write", home: true })).toBe(
      "home · read and write"
    );
  });

  test("other folders are read and write", () => {
    expect(folderLabel({ access: "read_write", home: false })).toBe(
      "read and write"
    );
  });
});

describe("LIBRARY_NOTE", () => {
  test("says access per folder comes later", () => {
    expect(LIBRARY_NOTE).toBe("Access per folder comes later.");
  });
});

describe("addressText", () => {
  test("joins the local part and the domain", () => {
    expect(addressText("sorter", "agents.example.com")).toBe(
      "sorter@agents.example.com"
    );
  });

  test("is null without a local part", () => {
    expect(addressText(null, "agents.example.com")).toBeNull();
  });
});
