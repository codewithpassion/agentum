import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { Atomic, Statement } from "./atomic.ts";
import type { Database } from "./database.ts";
import { mapPositions } from "./schema/map.ts";
import { triggers as triggerRows } from "./schema/triggers.ts";
import type { MapTriggerKind, MapWireKind } from "./shared.ts";

export interface GraphAgent {
  computerId: string | null;
  computerStatus: string | null;
  handsTo: string;
  id: string;
  name: string;
  runtimeConfig: string;
  waitingRuns: string;
}

/** Workspace-wide reads, independent of the number of agents or wires. */
export const graphNodes = async (db: Database, workspaceId: string) => {
  const [agents, triggers, ports, positions] = await Promise.all([
    db.all<GraphAgent>(sql`select a.id, a.name, a.hands_to as handsTo,
      a.runtime_config as runtimeConfig, a.computer_machine_id as computerId,
      m.computer_status as computerStatus,
      (select json_group_array(r.id) from runs r where r.agent_id = a.id and r.workspace_id = ${workspaceId}
        and r.status = 'waiting' and r.dry_run = 0) as waitingRuns
      from agents a left join machines m on m.id = a.computer_machine_id and m.workspace_id = a.workspace_id
      where a.workspace_id = ${workspaceId} and a.status not in ('draft', 'archived') order by a.id`),
    db.all<{
      id: string;
      agentId: string;
      kind: MapTriggerKind;
      label: string;
    }>(sql`
      select t.id, t.agent_id as agentId, t.kind,
        case when t.kind = 'mail' then coalesce(m.address, t.name) else t.name end as label
      from triggers t left join agent_mailboxes m on m.agent_id = t.agent_id and m.workspace_id = t.workspace_id
      where t.workspace_id = ${workspaceId} and t.revoked_at is null
      union all select 'slack:' || s.id, s.agent_id, 'slack', 'Slack'
      from slack_apps s where s.workspace_id = ${workspaceId} and s.status <> 'revoked' order by 1`),
    // The spec's connector_assignments is named agent_connectors in this schema.
    db.all<{
      agentId: string;
      id: string;
      kind: "connector" | "skill";
      label: string;
    }>(sql`
      select ac.agent_id as agentId, c.id, 'connector' as kind, c.name as label
      from agent_connectors ac join connectors c on c.id = ac.connector_id and c.workspace_id = ac.workspace_id
      where ac.workspace_id = ${workspaceId}
      union all select sa.agent_id, s.id, 'skill', s.name
      from skill_assignments sa join skills s on s.id = sa.skill_id and s.workspace_id = sa.workspace_id
      where sa.workspace_id = ${workspaceId} and s.deleted = 0 order by 1, 3, 2`),
    db.all<{ key: string; x: number; y: number }>(
      sql`select node_key as key, x, y from map_positions where workspace_id = ${workspaceId}`
    ),
  ]);
  return { agents, ports, positions, triggers };
};

export interface GraphCount {
  active: number;
  count7d: number;
  from: string;
  kind: MapWireKind;
  to: string;
}

/**
 * One bounded, indexed grouped read per type; run.queued supplies two wire kinds.
 * Slack events identify only the agent, so each of its apps shows the agent total.
 * A wire is active only while its linked run is queued, offered or running.
 */
export const graphCounts = async (
  db: Database,
  workspaceId: string,
  since: string,
  until: string
): Promise<GraphCount[]> => {
  const specs = [
    [
      "trigger.fired",
      sql`'trigger:' || e.actor_id`,
      sql`'agent:' || e.agent_id`,
      sql`'trigger'`,
    ],
    [
      "run.queued",
      sql`case when json_extract(e.payload, '$.origin') = 'slack' and r.parent_run_id is null then 'trigger:slack:' || s.id else 'agent:' || p.agent_id end`,
      sql`'agent:' || e.agent_id`,
      sql`case when json_extract(e.payload, '$.origin') = 'slack' and r.parent_run_id is null then 'trigger' else 'handoff' end`,
    ],
    [
      "mail.received",
      sql`'trigger:' || t.id`,
      sql`'agent:' || e.agent_id`,
      sql`'trigger'`,
    ],
    [
      "slack.message_sent",
      sql`'agent:' || e.agent_id`,
      sql`'out:slack:' || json_extract(e.payload, '$.channel')`,
      sql`'slack'`,
    ],
    [
      "library.write",
      sql`'agent:' || e.agent_id`,
      sql`'out:library:' || (${libraryFolder})`,
      sql`'library'`,
    ],
    ["qa.asked", sql`'agent:' || e.agent_id`, sql`'out:qa'`, sql`'qa'`],
    ["qa.answered", sql`'agent:' || e.agent_id`, sql`'out:qa'`, sql`'qa'`],
    [
      "mail.sent",
      sql`'agent:' || e.agent_id`,
      sql`'out:email:' || e.agent_id`,
      sql`'email'`,
    ],
  ] as const;
  return (
    await Promise.all(
      specs.map(([type, from, to, kind]) =>
        db.all<GraphCount>(sql`
    select ${from} as "from", ${to} as "to", ${kind} as kind, count(*) as count7d,
      max(case when r.status in ('queued', 'offered', 'running') then 1 else 0 end) as active
    from events e indexed by events_workspace_type_created_idx
    left join runs r on r.id = e.run_id and r.workspace_id = e.workspace_id
    ${
      type === "run.queued"
        ? sql`left join runs p on p.id = r.parent_run_id and p.workspace_id = e.workspace_id
      left join slack_apps s on s.agent_id = e.agent_id and s.workspace_id = e.workspace_id and s.status <> 'revoked' and r.parent_run_id is null`
        : sql``
    }
    ${type === "mail.received" ? sql`join triggers t on t.agent_id = e.agent_id and t.workspace_id = e.workspace_id and t.kind = 'mail' and t.revoked_at is null` : sql``}
    where e.workspace_id = ${workspaceId} and e.type = ${type}
      and e.created_at >= ${since} and e.created_at <= ${until}
      and (e.run_id is null or r.dry_run = 0)
      ${type === "run.queued" ? sql`and (p.dry_run = 0 or (r.parent_run_id is null and json_extract(e.payload, '$.origin') = 'slack'))` : sql``}
    group by 1, 2, 3 having "from" is not null and "to" is not null
  `)
      )
    )
  ).flat();
};

// agents/<slug>/ is one node, task folders under it included, so the map does
// not grow by one node per run. Other paths use their first segment, including
// a root-level filename.
const folderOf = (path: SQL): SQL => {
  const tail = sql`substr(${path}, 8)`;
  return sql`case when ${path} like 'agents/%/%' then 'agents/' || substr(${tail}, 1, instr(${tail}, '/') - 1)
    else case when instr(${path}, '/') > 0 then substr(${path}, 1, instr(${path}, '/') - 1) else ${path} end end`;
};
const libraryFolder = folderOf(sql`json_extract(e.payload, '$.path')`);

/** Persisted destinations keep output wires visible even when the window is idle. */
export const graphOutputs = async (
  db: Database,
  workspaceId: string
): Promise<GraphCount[]> => {
  const rows = await db.all<{
    agentId: string;
    destination: string;
    kind: "slack" | "library" | "qa" | "email";
  }>(sql`
    select agent_id as agentId, 'out:slack:' || channel_id as destination, 'slack' as kind
    from slack_threads where workspace_id = ${workspaceId}
    union select v.author_id, 'out:library:' || (${folderOf(sql`v.path`)}), 'library'
    from library_versions v left join runs r on r.id = v.run_id and r.workspace_id = v.workspace_id
    where v.workspace_id = ${workspaceId} and v.author_kind = 'agent' and v.op = 'write' and (v.run_id is null or r.dry_run = 0)
    union select q.author_id, 'out:qa', 'qa' from qa_questions q
    left join runs r on r.id = q.run_id and r.workspace_id = q.workspace_id
    where q.workspace_id = ${workspaceId} and q.author_kind = 'agent' and (q.run_id is null or r.dry_run = 0)
    union select q.author_id, 'out:qa', 'qa' from qa_answers q
    left join runs r on r.id = q.run_id and r.workspace_id = q.workspace_id
    where q.workspace_id = ${workspaceId} and q.author_kind = 'agent' and (q.run_id is null or r.dry_run = 0)
    union select agent_id, 'out:email:' || agent_id, 'email' from agent_mailboxes where workspace_id = ${workspaceId}
    order by 1, 2, 3
  `);
  return rows.map((row) => ({
    active: 0,
    count7d: 0,
    from: `agent:${row.agentId}`,
    kind: row.kind,
    to: row.destination,
  }));
};

/** Only movable wire kinds; mailbox and Slack ownership stays with their services. */
export const findMapTrigger = async (
  db: Database,
  workspaceId: string,
  id: string
) => {
  const [row] = await db
    .select()
    .from(triggerRows)
    .where(
      and(
        eq(triggerRows.id, id),
        eq(triggerRows.workspaceId, workspaceId),
        inArray(triggerRows.kind, ["http", "routine"]),
        isNull(triggerRows.revokedAt)
      )
    )
    .limit(1);
  return row;
};

export const upsertMapPositions = async (
  db: Database,
  atomic: Atomic,
  workspaceId: string,
  positions: { key: string; x: number; y: number }[],
  updatedAt: string
) => {
  // Duplicate keys apply in input order: the last position wins.
  // Five bound columns per row: keep each statement within D1's parameter cap.
  const statements: Statement[] = [];
  for (let start = 0; start < positions.length; start += 20) {
    statements.push(
      db
        .insert(mapPositions)
        .values(
          positions.slice(start, start + 20).map(({ key, x, y }) => ({
            nodeKey: key,
            updatedAt,
            workspaceId,
            x,
            y,
          }))
        )
        .onConflictDoUpdate({
          set: {
            updatedAt: sql`excluded.updated_at`,
            x: sql`excluded.x`,
            y: sql`excluded.y`,
          },
          target: [mapPositions.workspaceId, mapPositions.nodeKey],
        })
    );
  }
  await atomic(statements);
};
