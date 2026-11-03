import type { ProfileGap } from "@repo/db/shared";
import { VOICE_PRESETS } from "@repo/db/shared";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { Row } from "../profile/profile-row.tsx";
import {
  decideText,
  type Locked,
  rulesOf,
  runsOnOptions,
  toggleId,
  toggleStart,
} from "./builder-logic.ts";
import {
  GapNote,
  KeptNote,
  RemovableChip,
  ToggleChip,
} from "./toggle-chip.tsx";

const LOOKUP_DELAY_MS = 400;
const CHIPS = "flex flex-wrap items-center gap-1.5";
const MUTED = "text-muted-foreground text-xs";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const capitalise = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);

export interface DraftCardProps {
  /** The address local part, page state. */
  address: string;
  catalog: BuilderCatalog;
  draft: AgentDraft;
  /** Open gaps only, already filtered. */
  gaps: ProfileGap[];
  locked: Locked;
  onAddress: (local: string) => void;
  onEdit: (patch: Partial<AgentDraft>) => void;
}

/** The right-hand card that shows the draft and lets the person change it. */
export function DraftCard({
  address,
  catalog,
  draft,
  gaps,
  locked,
  onAddress,
  onEdit,
}: DraftCardProps) {
  const [hint, setHint] = useState<string | undefined>();
  const [rulesText, setRulesText] = useState(draft.rules.join("\n"));
  const latestAddress = useRef(address);

  useEffect(() => {
    latestAddress.current = address;
  }, [address]);

  useEffect(() => {
    setRulesText((text) =>
      rulesOf(text).join("\n") === draft.rules.join("\n")
        ? text
        : draft.rules.join("\n")
    );
  }, [draft.rules]);

  // A result for an address the person has since changed is dropped.
  const lookup = useCallback(async (local: string) => {
    if (local === "") {
      setHint(undefined);
      return;
    }
    try {
      const { available } = await getTrpc().agents.checkAddress.query({
        local,
      });
      if (latestAddress.current === local) {
        setHint(available ? "Available" : "That address is taken");
      }
    } catch (error) {
      if (latestAddress.current === local) {
        setHint(errorMessage(error));
      }
    }
  }, []);

  useEffect(() => {
    setHint(undefined);
    const timer = window.setTimeout(() => {
      lookup(address);
    }, LOOKUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [address, lookup]);

  const changeAddress = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onAddress(event.target.value.toLowerCase()),
    [onAddress]
  );
  const blurAddress = useCallback(() => lookup(address), [address, lookup]);
  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onEdit({ name: event.target.value }),
    [onEdit]
  );
  const changeDoes = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onEdit({ does: event.target.value }),
    [onEdit]
  );
  const changeRulesText = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      setRulesText(event.target.value),
    []
  );
  const commitRules = useCallback(
    () => onEdit({ rules: rulesOf(rulesText) }),
    [onEdit, rulesText]
  );

  const pickVoice = useCallback(
    (id: string) => {
      const voice = VOICE_PRESETS.find((preset) => preset === id);
      if (voice !== undefined) {
        onEdit({ voice });
      }
    },
    [onEdit]
  );
  const toggleTool = useCallback(
    (id: string) => onEdit({ tools: toggleId(draft.tools, id) }),
    [draft.tools, onEdit]
  );
  const toggleSkill = useCallback(
    (id: string) => onEdit({ skills: toggleId(draft.skills, id) }),
    [draft.skills, onEdit]
  );
  const toggleHandsTo = useCallback(
    (id: string) => onEdit({ handsTo: toggleId(draft.handsTo, id) }),
    [draft.handsTo, onEdit]
  );
  const toggleStartKind = useCallback(
    (id: string) => {
      if (id === "mail" || id === "slack_mention") {
        onEdit({ startsOn: toggleStart(draft.startsOn, id) });
      }
    },
    [draft.startsOn, onEdit]
  );
  const removeStart = useCallback(
    (index: number) =>
      onEdit({
        startsOn: draft.startsOn.filter((_, position) => position !== index),
      }),
    [draft.startsOn, onEdit]
  );
  const pickRuns = useCallback(
    (key: string) => {
      const option = runsOnOptions(catalog, draft.runsOn).find(
        (item) => item.key === key
      );
      if (option !== undefined) {
        onEdit({ runsOn: option.value });
      }
    },
    [catalog, draft.runsOn, onEdit]
  );

  const gapsOn = (field: ProfileGap["field"]) =>
    gaps.filter((gap) => gap.field === field);
  const startsSelected = (kind: "mail" | "slack_mention") =>
    draft.startsOn.some((start) => start.kind === kind);
  const runsOptions = runsOnOptions(catalog, draft.runsOn);
  const routineStarts = draft.startsOn.flatMap((start, index) =>
    start.kind === "routine" ? [{ index, label: start.label }] : []
  );

  return (
    <section
      aria-label="Review the draft"
      className="rounded-lg border-2 border-primary border-dashed bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-3.5">
        <span
          className={`grid size-[52px] shrink-0 place-items-center rounded-xl font-bold text-lg text-white ${agentTileColour(draft.name)}`}
        >
          {agentInitials(draft.name)}
        </span>
        <div className="min-w-0 flex-[1_1_220px]">
          <Input
            aria-label="Agent name"
            className="h-9 font-heading text-lg"
            onChange={changeName}
            value={draft.name}
          />
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Input
              aria-label="Address"
              className="h-8 w-44 font-mono"
              onBlur={blurAddress}
              onChange={changeAddress}
              value={address}
            />
            <span className="font-mono text-sm">@</span>
            {hint === undefined ? null : <span className={MUTED}>{hint}</span>}
            <GapNote gaps={gapsOn("address")} />
          </div>
        </div>
        <span className="ml-auto rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning text-xs">
          Draft
        </span>
      </header>

      <div className="mt-3">
        <Row label="Does">
          <div className="flex flex-col gap-1.5">
            <Textarea
              aria-label="Does"
              onChange={changeDoes}
              value={draft.does}
            />
            <KeptNote field="does" locked={locked} />
            <GapNote gaps={gapsOn("does")} />
          </div>
        </Row>

        <Row label="Voice">
          <div className={CHIPS}>
            {VOICE_PRESETS.map((preset) => (
              <ToggleChip
                id={preset}
                key={preset}
                label={capitalise(preset)}
                onToggle={pickVoice}
                selected={draft.voice === preset}
              />
            ))}
            <KeptNote field="voice" locked={locked} />
            <GapNote gaps={gapsOn("voice")} />
          </div>
        </Row>

        <Row label="Rules">
          <div className="flex flex-col gap-1.5">
            <Textarea
              aria-label="Rules"
              onBlur={commitRules}
              onChange={changeRulesText}
              placeholder="One rule per line"
              value={rulesText}
            />
            <KeptNote field="rules" locked={locked} />
            <GapNote gaps={gapsOn("rules")} />
          </div>
        </Row>

        <Row label="Tools">
          <div className={CHIPS}>
            {catalog.connectors.length === 0 ? (
              <span className={MUTED}>No connectors yet.</span>
            ) : null}
            {catalog.connectors.map((connector) => (
              <ToggleChip
                id={connector.id}
                key={connector.id}
                label={connector.name}
                onToggle={toggleTool}
                selected={draft.tools.includes(connector.id)}
              />
            ))}
            <KeptNote field="tools" locked={locked} />
            <GapNote gaps={gapsOn("tools")} />
          </div>
        </Row>

        <Row label="Skills">
          <div className={CHIPS}>
            {catalog.skills.length === 0 ? (
              <span className={MUTED}>No skills yet.</span>
            ) : null}
            {catalog.skills.map((skill) => (
              <ToggleChip
                id={skill.id}
                key={skill.id}
                label={skill.name}
                onToggle={toggleSkill}
                selected={draft.skills.includes(skill.id)}
              />
            ))}
            <KeptNote field="skills" locked={locked} />
            <GapNote gaps={gapsOn("skills")} />
          </div>
        </Row>

        <Row label="Starts on">
          <div className={CHIPS}>
            {routineStarts.map((start) => (
              <RemovableChip
                index={start.index}
                key={`routine:${start.index}`}
                label={start.label}
                onRemove={removeStart}
              />
            ))}
            <ToggleChip
              id="mail"
              label="Mail"
              onToggle={toggleStartKind}
              selected={startsSelected("mail")}
            />
            <ToggleChip
              id="slack_mention"
              label="Slack mention"
              onToggle={toggleStartKind}
              selected={startsSelected("slack_mention")}
            />
            <KeptNote field="startsOn" locked={locked} />
            <GapNote gaps={gapsOn("starts_on")} />
          </div>
        </Row>

        <Row label="Hands to">
          <div className={CHIPS}>
            {catalog.agents.length === 0 ? (
              <span className={MUTED}>No other agents yet.</span>
            ) : null}
            {catalog.agents.map((agent) => (
              <ToggleChip
                id={agent.id}
                key={agent.id}
                label={agent.name}
                onToggle={toggleHandsTo}
                selected={draft.handsTo.includes(agent.id)}
              />
            ))}
            <KeptNote field="handsTo" locked={locked} />
            <GapNote gaps={gapsOn("hands_to")} />
          </div>
        </Row>

        <Row label="Runs on">
          <div className={CHIPS}>
            {runsOptions.length === 0 ? (
              <span className={MUTED}>
                No runtime is available. Add a provider key or a machine in
                Settings.
              </span>
            ) : null}
            {runsOptions.map((option) => (
              <ToggleChip
                id={option.key}
                key={option.key}
                label={
                  option.note === null
                    ? option.label
                    : `${option.label} (${option.note})`
                }
                onToggle={pickRuns}
                selected={option.selected}
                warn={draft.runsOn === null}
              />
            ))}
            <KeptNote field="runsOn" locked={locked} />
            <GapNote gaps={gapsOn("runs_on")} />
          </div>
        </Row>
      </div>

      {gaps.length === 0 ? null : (
        <div className="mt-3 rounded-lg border border-warning/40 bg-warning/15 p-3 text-sm text-warning">
          <p className="font-semibold">{decideText(gaps.length)}</p>
          {gaps.map((gap) => (
            <p key={`${gap.field}:${gap.question}`}>{gap.question}</p>
          ))}
        </div>
      )}
    </section>
  );
}
