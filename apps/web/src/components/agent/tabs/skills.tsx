import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { LibraryFilePanel } from "#/components/library/library-file-panel";
import { errorMessage } from "#/components/library/library-logic.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { SkillEntry } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";

function SkillRow({
  skill,
  onOpen,
}: {
  skill: SkillEntry;
  onOpen: (path: string) => void;
}) {
  const open = useCallback(() => onOpen(skill.path), [skill.path, onOpen]);
  const name = skill.name ?? skill.folder;

  let detail: ReactNode = null;
  if (skill.problem !== null) {
    detail = <p className="text-destructive text-sm">{skill.problem}</p>;
  } else if (skill.description !== null) {
    detail = (
      <p className="text-muted-foreground text-sm">{skill.description}</p>
    );
  }

  return (
    <li>
      <button
        className="flex w-full flex-col gap-1 py-3 text-left text-foreground hover:text-primary"
        data-testid="skill-row"
        onClick={open}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{name}</span>
          {skill.scope === "shared" ? (
            <Badge className="text-muted-foreground" variant="outline">
              Shared
            </Badge>
          ) : null}
        </span>
        {detail}
      </button>
    </li>
  );
}

function SkillsList({
  skills,
  onOpen,
}: {
  skills: SkillEntry[];
  onOpen: (path: string) => void;
}) {
  if (skills.length === 0) {
    return <p className="text-muted-foreground text-sm">No skills yet.</p>;
  }
  return (
    <ul className="divide-y divide-border border-border border-y">
      {skills.map((skill) => (
        <SkillRow key={skill.path} onOpen={onOpen} skill={skill} />
      ))}
    </ul>
  );
}

function SkillsPanel({ agent }: AgentTabProps) {
  const agentId = agent.id;
  const [skills, setSkills] = useState<SkillEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | undefined>();
  const [openPath, setOpenPath] = useState<string | undefined>();
  // The agent this panel shows. Null after unmount, so a late response is dropped.
  const shownAgent = useRef<string | null>(null);

  useEffect(() => {
    shownAgent.current = agentId;
    return () => {
      shownAgent.current = null;
    };
  }, [agentId]);

  const reload = useCallback(() => {
    getTrpc()
      .skills.list.query({ agentId })
      .then((items) => {
        if (shownAgent.current === agentId) {
          setSkills(items);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (shownAgent.current === agentId) {
          setError(errorMessage(cause));
        }
      });
  }, [agentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const changeName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const createSkill = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      let created: { path: string };
      try {
        created = await getTrpc().skills.create.mutate({
          agentId,
          name: name.trim(),
        });
      } catch (cause) {
        setCreateError(errorMessage(cause));
        return;
      }
      setName("");
      setCreateError(undefined);
      setOpenPath(created.path);
      reload();
    },
    [agentId, name, reload]
  );

  const openSkill = useCallback((path: string) => setOpenPath(path), []);

  const closeEditor = useCallback(() => setOpenPath(undefined), []);

  let body: ReactNode;
  if (skills === undefined) {
    body =
      error === undefined ? (
        <p className="text-muted-foreground text-sm">Loading skills.</p>
      ) : (
        <p className="text-destructive text-sm">{error}</p>
      );
  } else {
    body = (
      <>
        {error === undefined ? null : (
          <p className="text-destructive text-sm">{error}</p>
        )}
        <SkillsList onOpen={openSkill} skills={skills} />
      </>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <form className="flex flex-col gap-2" onSubmit={createSkill}>
        <Label htmlFor="skill-name-input">Skill name</Label>
        <div className="flex items-center gap-2">
          <Input
            data-testid="skill-name-input"
            id="skill-name-input"
            onChange={changeName}
            placeholder="my-skill"
            value={name}
          />
          <Button data-testid="skill-create" type="submit">
            New skill
          </Button>
        </div>
        {createError === undefined ? null : (
          <p
            className="text-destructive text-sm"
            data-testid="skill-create-error"
          >
            {createError}
          </p>
        )}
      </form>
      {body}
      {openPath === undefined ? null : (
        <LibraryFilePanel
          key={openPath}
          onChanged={reload}
          onClosed={closeEditor}
          path={openPath}
        />
      )}
    </section>
  );
}

export const skillsTab: AgentTab = {
  id: "skills",
  label: "Skills",
  Panel: SkillsPanel,
};
