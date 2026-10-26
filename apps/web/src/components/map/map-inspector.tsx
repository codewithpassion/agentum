import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { runtimeWords } from "#/components/agent/profile/profile-logic.ts";
import { bandClass } from "#/components/desk/desk-logic.ts";
import { RequestCard } from "#/components/requests/request-card.tsx";
import {
  type AnswerPayload,
  type RequestView,
  viewFromRecord,
} from "#/components/requests/request-card-logic.ts";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import type {
  AgentProfileView,
  AgentRecord,
  MailboxRecord,
  RouterOutputs,
} from "#/integrations/trpc/types";
import {
  countOf,
  itemsText,
  labelOf,
  lastFiredText,
  outputWord,
  type ShownRun,
  shownRunOf,
  triggerFacts,
  triggerWord,
  wiresFrom,
  wiresInto,
} from "./inspector-logic.ts";
import { AgentEditor } from "./map-inspector-editor.tsx";
import { agentIdOf, initialsOf } from "./map-logic.ts";

const CHIP = "rounded-full border border-border px-2 py-0.5 text-xs";
const WARN_CHIP =
  "rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100";

type MapGraphView = RouterOutputs["map"]["graph"];
type MapNodeView = MapGraphView["nodes"][number];

function Tile({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-muted font-semibold text-foreground text-xs"
    >
      {initialsOf(label)}
    </span>
  );
}

function Chips({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap justify-end gap-1">{children}</span>;
}

/** One line of a panel: a muted name on the left, its value on the right. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-border border-t py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function NoneText() {
  return <span className="text-muted-foreground text-sm">None</span>;
}

function ConnectorRow({ profile }: { profile: AgentProfileView }) {
  const { connectors } = profile.tools;
  return (
    <InfoRow label="Tools">
      {connectors.length === 0 ? (
        <NoneText />
      ) : (
        <Chips>
          {connectors.map((connector) => (
            <span className={CHIP} key={connector.connectorId}>
              {connector.name}
            </span>
          ))}
        </Chips>
      )}
    </InfoRow>
  );
}

function SkillRow({ profile }: { profile: AgentProfileView }) {
  const { skills } = profile;
  return (
    <InfoRow label="Skills">
      {skills.length === 0 ? (
        <NoneText />
      ) : (
        <Chips>
          {skills.map((skill) => (
            <Fragment key={skill.skillId}>
              <span className={CHIP}>{skill.name}</span>
              {skill.proposedVersion === null ? null : (
                <span className={WARN_CHIP}>
                  v{skill.proposedVersion} proposed
                </span>
              )}
            </Fragment>
          ))}
        </Chips>
      )}
    </InfoRow>
  );
}

function SecretRow({ profile }: { profile: AgentProfileView }) {
  const { secrets } = profile.tools;
  return (
    <InfoRow label="Secrets">
      {secrets.length === 0 ? (
        <NoneText />
      ) : (
        <Chips>
          {secrets.map((secret) => (
            <span className={CHIP} key={secret.id}>
              {secret.name} · hidden
            </span>
          ))}
        </Chips>
      )}
    </InfoRow>
  );
}

function PluggedIn({
  node,
  profile,
}: {
  node: MapNodeView;
  profile: AgentProfileView;
}) {
  const computer = node.ports.find((port) => port.kind === "computer");
  const hasBrowser = node.ports.some((port) => port.kind === "browser");
  return (
    <>
      <p className="mt-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Plugged in
      </p>
      <div>
        <InfoRow label="Model">
          <span className={CHIP}>{profile.header.model}</span>
        </InfoRow>
        <ConnectorRow profile={profile} />
        <InfoRow label="Computer">
          {computer === undefined ? (
            <NoneText />
          ) : (
            <span className="text-sm">
              {computer.label}
              {computer.status ? ` · ${computer.status}` : ""}
            </span>
          )}
        </InfoRow>
        <InfoRow label="Browser">
          {hasBrowser ? (
            <span className={CHIP}>Browser</span>
          ) : (
            <span className="text-muted-foreground text-sm">Off</span>
          )}
        </InfoRow>
        <SkillRow profile={profile} />
        <SecretRow profile={profile} />
      </div>
    </>
  );
}

/** What the editor needs: the agent and mailbox it edits, and the reload after a change. */
interface EditorState {
  agent: AgentRecord | null;
  mailbox: MailboxRecord | null;
  onChanged: () => void;
}

const doNothing = (): void => undefined;

/** The editable rows in place of the read-only "Plugged in" block. */
function EditableProfile({
  editor,
  profile,
  profileError,
}: {
  editor: EditorState;
  profile: AgentProfileView | null;
  profileError: string | null;
}) {
  if (profile === null || editor.agent === null) {
    return <ProfileStatus error={profileError} />;
  }
  return (
    <AgentEditor
      agent={editor.agent}
      mailbox={editor.mailbox}
      onChanged={editor.onChanged}
      profile={profile}
    />
  );
}

function LastRun({
  node,
  nowMs,
  onAnswer,
  run,
}: {
  node: MapNodeView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  run: ShownRun;
}) {
  const pending =
    node.pendingRequest === undefined
      ? null
      : viewFromRecord(node.pendingRequest, null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <p className="font-semibold text-sm">{run.title}</p>
        {run.band === null ? null : (
          <p
            className={`truncate rounded-md border px-2 py-1 text-xs ${bandClass(run.band.tone)}`}
          >
            {run.band.text}
          </p>
        )}
        {pending === null ? null : (
          <RequestCard nowMs={nowMs} onAnswer={onAnswer} view={pending} />
        )}
        {node.waiting === true && pending === null ? (
          <p className="text-muted-foreground text-xs">
            Waiting for a person. The request is expired or not visible to you.
          </p>
        ) : null}
      </div>
      <Link
        className={buttonVariants({ size: "sm", variant: "outline" })}
        params={{ runId: run.id }}
        to="/tasks/$runId"
      >
        Open task
      </Link>
    </div>
  );
}

function AgentBody({
  editor,
  node,
  nowMs,
  onAnswer,
  profile,
  profileError,
}: {
  editor: EditorState | null;
  node: MapNodeView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  profile: AgentProfileView | null;
  profileError: string | null;
}) {
  const run = shownRunOf(
    node.pendingRequest?.runId,
    profile?.recentTasks ?? []
  );
  let plugged: ReactNode;
  if (editor !== null) {
    plugged = (
      <EditableProfile
        editor={editor}
        profile={profile}
        profileError={profileError}
      />
    );
  } else if (profile === null) {
    plugged = <ProfileStatus error={profileError} />;
  } else {
    plugged = <PluggedIn node={node} profile={profile} />;
  }
  return (
    <>
      {plugged}
      {profile === null && run === null ? null : (
        <>
          <p className="mt-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Last run
          </p>
          <div className="mt-1">
            {run === null ? (
              <p className="text-muted-foreground text-sm">No runs yet.</p>
            ) : (
              <LastRun
                node={node}
                nowMs={nowMs}
                onAnswer={onAnswer}
                run={run}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

function ProfileStatus({ error }: { error: string | null }) {
  return error === null ? (
    <p className="mt-3 text-muted-foreground text-sm">Loading…</p>
  ) : (
    <p className="mt-3 text-destructive text-sm" role="alert">
      {error}
    </p>
  );
}

function TriggerBody({
  graph,
  node,
  profile,
}: {
  graph: MapGraphView;
  node: MapNodeView;
  profile: AgentProfileView | null;
}) {
  const outgoing = wiresFrom(graph, node.key);
  const starts = outgoing.map((wire) => ({
    key: wire.to,
    name: labelOf(graph, wire.to),
  }));
  const facts = triggerFacts(node.key, profile);
  return (
    <div>
      <InfoRow label="Starts">
        {starts.length === 0 ? (
          <NoneText />
        ) : (
          <Chips>
            {starts.map((entry) => (
              <span className={CHIP} key={entry.key}>
                {entry.name}
              </span>
            ))}
          </Chips>
        )}
      </InfoRow>
      <InfoRow label="Last fired">
        <span className="text-sm">
          {lastFiredText(facts, profile !== null)}
        </span>
      </InfoRow>
      <InfoRow label="Last 7 days">
        <span className="text-sm">{countOf(outgoing)} fired</span>
      </InfoRow>
    </div>
  );
}

function OutputBody({
  graph,
  node,
}: {
  graph: MapGraphView;
  node: MapNodeView;
}) {
  const incoming = wiresInto(graph, node.key);
  const fedBy = incoming.map((wire) => ({
    key: wire.from,
    name: labelOf(graph, wire.from),
  }));
  return (
    <div>
      <InfoRow label="Fed by">
        {fedBy.length === 0 ? (
          <NoneText />
        ) : (
          <Chips>
            {fedBy.map((entry) => (
              <span className={CHIP} key={entry.key}>
                {entry.name}
              </span>
            ))}
          </Chips>
        )}
      </InfoRow>
      <InfoRow label="Last 7 days">
        <span className="text-sm">{itemsText(countOf(incoming))}</span>
      </InfoRow>
      {node.subkind === "qa" ? (
        <Link
          className={`${buttonVariants({ size: "sm", variant: "outline" })} mt-3`}
          search={{ status: undefined }}
          to="/qa"
        >
          Open the Q&A board
        </Link>
      ) : null}
    </div>
  );
}

const subtitleOf = (
  node: MapNodeView,
  profile: AgentProfileView | null
): string => {
  if (node.kind === "agent") {
    return profile === null
      ? "Agent"
      : `Agent · ${runtimeWords(profile.header.runtime, profile.header.machine)}`;
  }
  if (node.kind === "trigger") {
    return `Trigger · ${triggerWord(node.subkind)}`;
  }
  return `Output · ${outputWord(node.subkind)}`;
};

export interface MapInspectorProps {
  editor?: boolean;
  editorAgent?: AgentRecord | null;
  editorMailbox?: MailboxRecord | null;
  graph: MapGraphView;
  node: MapNodeView;
  nowMs: number;
  onAnswer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  onChanged?: () => void;
  onClose: () => void;
  profile: AgentProfileView | null;
  /** The agent whose profile the node shows: its own, or the one a trigger starts. */
  profileAgentId?: string | null;
  profileError: string | null;
}

/** The panel beside the map that describes the selected node. */
export function MapInspector({
  editor,
  editorAgent,
  editorMailbox,
  graph,
  node,
  nowMs,
  onAnswer,
  onChanged,
  onClose,
  profile,
  profileAgentId = null,
  profileError,
}: MapInspectorProps) {
  const agentId = agentIdOf(node.key);
  const editing: EditorState | null =
    editor === true
      ? {
          agent: editorAgent ?? null,
          mailbox: editorMailbox ?? null,
          onChanged: onChanged ?? doNothing,
        }
      : null;
  let profileLinkId: string | null = null;
  if (node.kind === "agent") {
    profileLinkId = agentId;
  } else if (editor === true) {
    profileLinkId = profileAgentId;
  }
  return (
    <aside
      aria-label="Selected node"
      className="min-w-0 rounded-lg border border-border bg-card"
    >
      <div className="flex items-center gap-2.5 p-4">
        <Tile label={node.label} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-sm">{node.label}</h2>
          <p className="truncate text-muted-foreground text-xs">
            {subtitleOf(node, profile)}
          </p>
          {editor === true ? (
            <p className="font-medium text-primary text-xs">Editing</p>
          ) : null}
        </div>
        {profileLinkId === null ? null : (
          <Link
            className={buttonVariants({ size: "sm", variant: "outline" })}
            params={{ agentId: profileLinkId }}
            to="/agents/$agentId"
          >
            Profile
          </Link>
        )}
        <Button
          aria-label="Close inspector"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </Button>
      </div>
      <div className="px-4 pb-4">
        {node.kind === "agent" ? (
          <AgentBody
            editor={editing}
            node={node}
            nowMs={nowMs}
            onAnswer={onAnswer}
            profile={profile}
            profileError={profileError}
          />
        ) : null}
        {node.kind === "trigger" ? (
          <>
            <TriggerBody graph={graph} node={node} profile={profile} />
            {editing !== null && profileAgentId !== null ? (
              <EditableProfile
                editor={editing}
                profile={profile}
                profileError={profileError}
              />
            ) : null}
          </>
        ) : null}
        {node.kind === "output" ? (
          <OutputBody graph={graph} node={node} />
        ) : null}
      </div>
    </aside>
  );
}
