import { describe, expect, test } from "bun:test";
import type { MachineRecord } from "#/integrations/trpc/types";
import {
  addressText,
  browserChip,
  browserConfig,
  browserOn,
  channelChips,
  computerChoices,
  currentRuntime,
  folderLabel,
  handsToChips,
  LIBRARY_NOTE,
  machineAgentWords,
  mailProvisionLabel,
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

describe("currentRuntime", () => {
  const laptop = (status: "offline" | "online") => ({
    name: "laptop",
    status,
  });

  test("describes the runtime the agent has, in plain words", () => {
    expect(currentRuntime("managed", null)).toEqual({
      machineState: null,
      text: "Managed Agents. Simplest. Has its own sandbox.",
      title: "Anthropic cloud",
    });
    expect(currentRuntime("cloud", null)).toEqual({
      machineState: null,
      text: "Always on, lowest cost for many small jobs.",
      title: "Cloudflare",
    });
  });

  test("describes a test runner", () => {
    expect(currentRuntime("fake", null).title).toBe("Test runner");
  });

  test("names the machine and its state on the machine runtime", () => {
    const online = currentRuntime("machine", laptop("online"));
    expect(online.title).toBe("Our machine: laptop");
    expect(online.machineState).toBe("Online");
    expect(currentRuntime("machine", laptop("offline")).machineState).toBe(
      "Offline"
    );
  });

  test("a machine agent without a machine has no name or state", () => {
    const option = currentRuntime("machine", null);
    expect(option.title).toBe("Our machine");
    expect(option.machineState).toBeNull();
  });

  test("other runtimes show no machine name or state", () => {
    const option = currentRuntime("cloud", laptop("online"));
    expect(option.title).toBe("Cloudflare");
    expect(option.machineState).toBeNull();
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
    expect(channelChips(noSlack, null, null)).toEqual([
      { key: "slack", label: "Slack · not set up", tone: "default" },
      { key: "email", label: "Email · no address yet", tone: "default" },
      { key: "whatsapp", label: "WhatsApp (later)", tone: "default" },
    ]);
  });

  test("an installed Slack app and an email address are on", () => {
    expect(channelChips(slackWith("installed"), "robo", "active")).toEqual([
      { key: "slack", label: "Slack app", tone: "on" },
      { key: "email", label: "Email", tone: "on" },
      { key: "whatsapp", label: "WhatsApp (later)", tone: "default" },
    ]);
  });

  test("a created Slack app is not installed yet", () => {
    expect(channelChips(slackWith("created"), null, null)[0]).toEqual({
      key: "slack",
      label: "Slack app · not installed",
      tone: "default",
    });
  });

  test("a revoked Slack app is a warning", () => {
    expect(channelChips(slackWith("revoked"), null, null)[0]).toEqual({
      key: "slack",
      label: "Slack app · revoked",
      tone: "warn",
    });
  });

  test("an email address with no mailbox row yet is reserved", () => {
    expect(channelChips(noSlack, "robo", null)[1]).toEqual({
      key: "email",
      label: "Email · reserved",
      tone: "default",
    });
  });

  test("a provisioning mailbox is being set up", () => {
    expect(channelChips(noSlack, "robo", "provisioning")[1]).toEqual({
      key: "email",
      label: "Email · setting up",
      tone: "default",
    });
  });

  test("a failed mailbox is a warning", () => {
    expect(channelChips(noSlack, "robo", "failed")[1]).toEqual({
      key: "email",
      label: "Email · failed",
      tone: "warn",
    });
  });

  test("a disabled mailbox is off", () => {
    expect(channelChips(noSlack, "robo", "disabled")[1]).toEqual({
      key: "email",
      label: "Email · off",
      tone: "default",
    });
  });

  test("no address wins over the mailbox status", () => {
    expect(channelChips(noSlack, null, "active")[1]).toEqual({
      key: "email",
      label: "Email · no address yet",
      tone: "default",
    });
  });
});

describe("folderLabel", () => {
  test("the home folder says so", () => {
    expect(folderLabel({ access: "write", home: true })).toBe(
      "home · read and write"
    );
  });

  test("other folders are read and write", () => {
    expect(folderLabel({ access: "write", home: false })).toBe(
      "read and write"
    );
  });

  test("a read grant is read only", () => {
    expect(folderLabel({ access: "read", home: false })).toBe("read only");
  });
});

describe("LIBRARY_NOTE", () => {
  test("says the folders sync live and tasks write to their task folder", () => {
    expect(LIBRARY_NOTE).toBe(
      "On a machine or VM these folders sync live. Each task writes to its task folder."
    );
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

describe("machineAgentWords", () => {
  test("names the machine the agent runs on", () => {
    expect(machineAgentWords({ name: "laptop" })).toBe(
      "This agent runs on laptop."
    );
  });

  test("falls back when there is no machine", () => {
    expect(machineAgentWords(null)).toBe("This agent runs on a machine.");
  });
});

describe("computerChoices", () => {
  const computer = (overrides: Partial<MachineRecord> = {}): MachineRecord => ({
    capabilities: {},
    computerCapabilities: { desktop: true },
    computerLastSeenAt: null,
    computerStatus: "online",
    createdAt: "2026-01-01T00:00:00.000Z",
    daemonVersion: null,
    enrolledBy: "user_1",
    id: "m_desk",
    lastSeenAt: null,
    name: "desk",
    roles: ["computer"],
    singleUser: false,
    status: "offline",
    workspaceId: "ws_1",
    ...overrides,
  });

  test("is empty when no machine has a computer role", () => {
    const plain = computer({ id: "m_plain", roles: ["agent_host"] });
    expect(computerChoices(null, [plain])).toEqual([]);
    expect(computerChoices(null, [])).toEqual([]);
  });

  test("marks only the attached computer", () => {
    const other = computer({ id: "m_other", name: "other" });
    const choices = computerChoices("m_desk", [computer(), other]);
    expect(choices.map((choice) => [choice.id, choice.attached])).toEqual([
      ["m_desk", true],
      ["m_other", false],
    ]);
  });

  test("shows desktop and headless computers, with the status of the computer role", () => {
    const headless = computer({
      computerCapabilities: { desktop: false },
      computerStatus: "offline",
      id: "m_head",
      name: "server",
    });
    const choices = computerChoices(null, [computer(), headless]);
    expect(choices).toEqual([
      {
        attached: false,
        id: "m_desk",
        kind: "Desktop",
        name: "desk",
        status: "Online",
        tone: "good",
      },
      {
        attached: false,
        id: "m_head",
        kind: "Headless",
        name: "server",
        status: "Offline",
        tone: "muted",
      },
    ]);
  });

  test("leaves out a revoked machine", () => {
    const revoked = computer({ id: "m_gone", status: "revoked" });
    expect(computerChoices(null, [revoked])).toEqual([]);
  });

  test("keeps a revoked machine the agent still holds, so it can be detached", () => {
    const revoked = computer({ id: "m_gone", status: "revoked" });
    expect(computerChoices("m_gone", [revoked])).toMatchObject([
      { attached: true, id: "m_gone", status: "Revoked", tone: "bad" },
    ]);
  });

  test("says not connected yet when the computer has never said hello", () => {
    const fresh = computer({ computerCapabilities: null, id: "m_new" });
    expect(computerChoices(null, [fresh])[0]?.kind).toBe("Not connected yet");
  });
});

describe("mailProvisionLabel", () => {
  test("a provisioning mailbox offers Try again", () => {
    expect(mailProvisionLabel("active", "robo", "provisioning")).toBe(
      "Try again"
    );
  });

  test("a failed mailbox offers Retry", () => {
    expect(mailProvisionLabel("active", "robo", "failed")).toBe("Retry");
  });

  test("an active mailbox offers nothing", () => {
    expect(mailProvisionLabel("active", "robo", "active")).toBeNull();
  });

  test("a disabled mailbox offers nothing", () => {
    expect(mailProvisionLabel("active", "robo", "disabled")).toBeNull();
  });

  test("an active agent with an address and no mailbox offers Set up mail", () => {
    expect(mailProvisionLabel("active", "robo", null)).toBe("Set up mail");
  });

  test("an active agent with no address offers nothing", () => {
    expect(mailProvisionLabel("active", null, null)).toBeNull();
  });

  test("a draft agent with no mailbox offers nothing", () => {
    expect(mailProvisionLabel("draft", "robo", null)).toBeNull();
  });
});

describe("browser tool", () => {
  test("is on unless the runtime config turns it off", () => {
    expect(browserOn({})).toBe(true);
    expect(browserOn({ browser: true })).toBe(true);
    expect(browserOn({ browser: false })).toBe(false);
  });

  test("the chip shows on or off", () => {
    expect(browserChip(true)).toEqual({
      key: "browser",
      label: "Browser",
      tone: "on",
    });
    expect(browserChip(false)).toEqual({
      key: "browser",
      label: "Browser · off",
      tone: "default",
    });
  });

  test("turning it on removes the browser key and keeps the rest", () => {
    const base = { browser: false, maxTurns: 5 };
    const config = browserConfig(base, true);
    expect(config).toEqual({ maxTurns: 5 });
    expect("browser" in config).toBe(false);
    expect(base).toEqual({ browser: false, maxTurns: 5 });
  });

  test("turning it off adds browser false and keeps the rest", () => {
    const base = { maxTurns: 5 };
    expect(browserConfig(base, false)).toEqual({
      browser: false,
      maxTurns: 5,
    });
    expect(base).toEqual({ maxTurns: 5 });
  });
});
