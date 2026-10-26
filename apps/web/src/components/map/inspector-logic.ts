// The logic behind the map inspector (V7.3): which wires join a node, the
// labels they show, and the facts a trigger reads from its agent's profile.
// Pure: `map-inspector.tsx` draws what these return.

import { formatDistanceToNow } from "date-fns";

export interface WireLike {
  active: boolean;
  count7d: number;
  from: string;
  kind: string;
  to: string;
}

export interface GraphLike {
  nodes: { key: string; label: string }[];
  wires: WireLike[];
}

/** A trigger row on an agent profile, or a routine, as far as the inspector reads it. */
export interface TriggerFact {
  id: string;
  lastFiredAt: string | null;
  name: string;
}

/** The part of an agent profile a trigger node reads. */
export interface TriggerSource {
  startsOn: { routines: TriggerFact[]; triggers: TriggerFact[] };
}

export interface TriggerFacts {
  lastFiredAt: string | null;
  name: string | null;
}

const TRIGGER_PREFIX = "trigger:";
const SLACK_PREFIX = "slack:";

const NO_FACTS: TriggerFacts = { lastFiredAt: null, name: null };

/** The wires that end at `key`. */
export const wiresInto = <W extends WireLike>(
  graph: { wires: W[] },
  key: string
): W[] => graph.wires.filter((wire) => wire.to === key);

/** The wires that start at `key`. */
export const wiresFrom = <W extends WireLike>(
  graph: { wires: W[] },
  key: string
): W[] => graph.wires.filter((wire) => wire.from === key);

/** The label of the node at `key`, or the key itself when the graph has no such node. */
export const labelOf = (graph: GraphLike, key: string): string =>
  graph.nodes.find((node) => node.key === key)?.label ?? key;

/**
 * The name and last fire time of the trigger a `trigger:<id>` key names, read
 * from the agent's triggers and routines. Slack keys, unknown ids and a missing
 * profile give no facts.
 */
export const triggerFacts = (
  key: string,
  profile: TriggerSource | null
): TriggerFacts => {
  if (profile === null || !key.startsWith(TRIGGER_PREFIX)) {
    return { ...NO_FACTS };
  }
  const id = key.slice(TRIGGER_PREFIX.length);
  if (id.startsWith(SLACK_PREFIX)) {
    return { ...NO_FACTS };
  }
  const match = [
    ...profile.startsOn.triggers,
    ...profile.startsOn.routines,
  ].find((fact) => fact.id === id);
  return match === undefined
    ? { ...NO_FACTS }
    : { lastFiredAt: match.lastFiredAt, name: match.name };
};

/** The sum of the 7-day counts on a set of wires. */
export const countOf = (wires: readonly WireLike[]): number =>
  wires.reduce((total, wire) => total + wire.count7d, 0);

const TRIGGER_WORDS: Record<string, string> = {
  http: "HTTP",
  mail: "Mail",
  routine: "Schedule",
  slack: "Slack",
};

const OUTPUT_WORDS: Record<string, string> = {
  email: "Email",
  library: "Library",
  qa: "Q&A board",
  slack: "Slack",
};

/** The short name of a trigger's kind, such as "Schedule" for a routine. */
export const triggerWord = (subkind: string | null): string =>
  subkind === null ? "Trigger" : (TRIGGER_WORDS[subkind] ?? subkind);

/** The short name of an output's kind, such as "Q&A board". */
export const outputWord = (subkind: string | null): string =>
  subkind === null ? "Output" : (OUTPUT_WORDS[subkind] ?? subkind);

/** "3 items" or "1 item". */
export const itemsText = (count: number): string =>
  `${count} ${count === 1 ? "item" : "items"}`;

/**
 * When a trigger last fired, such as "5 minutes ago". `unknown` covers a
 * profile that is still loading or a trigger the profile does not list.
 */
export const lastFiredText = (
  facts: TriggerFacts,
  profileLoaded: boolean
): string => {
  if (!profileLoaded || facts.name === null) {
    return "unknown";
  }
  if (facts.lastFiredAt === null) {
    return "never";
  }
  const at = new Date(facts.lastFiredAt);
  return Number.isNaN(at.getTime())
    ? "unknown"
    : formatDistanceToNow(at, { addSuffix: true });
};

/**
 * The agent whose profile the inspector reads: the agent itself, or for a
 * trigger the first agent it starts. An output has none.
 */
export const agentIdForProfile = (
  graph: { wires: WireLike[] },
  node: { key: string; kind: string }
): string | null => {
  const agentKey =
    node.kind === "trigger"
      ? wiresFrom(graph, node.key).find((wire) => wire.to.startsWith("agent:"))
          ?.to
      : node.key;
  return agentKey?.startsWith("agent:")
    ? agentKey.slice("agent:".length)
    : null;
};
