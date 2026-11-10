import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import {
  DESCRIPTION_MAX,
  emptySkill,
  publishProblem,
  SKILLS_MAX,
  SKILLS_MIN,
  type SkillDraft,
  toPublishSkills,
  withId,
  withName,
} from "./publish-form-logic.ts";

type PublishedCard = NonNullable<RouterOutputs["a2a"]["published"]>;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; card: PublishedCard | null };

const FORM_NOTE =
  "This text goes on the public card other agents read. It is never taken from the agent's instructions.";

const newKey = (): string => globalThis.crypto.randomUUID();

const fetchCard = (agentId: string): Promise<PublishedCard | null> =>
  getTrpc().a2a.published.query({ agentId });

function SkillRow({
  onChange,
  onRemove,
  removable,
  skill,
}: {
  onChange: (next: SkillDraft) => void;
  onRemove: (key: string) => void;
  removable: boolean;
  skill: SkillDraft;
}) {
  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(withName(skill, event.target.value));
    },
    [onChange, skill]
  );
  const handleId = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(withId(skill, event.target.value));
    },
    [onChange, skill]
  );
  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange({ ...skill, description: event.target.value });
    },
    [onChange, skill]
  );
  const handleTags = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...skill, tags: event.target.value });
    },
    [onChange, skill]
  );
  const remove = useCallback(() => onRemove(skill.key), [onRemove, skill.key]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${skill.key}-name`}>Name</Label>
          <Input
            id={`${skill.key}-name`}
            onChange={handleName}
            value={skill.name}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${skill.key}-id`}>Id</Label>
          <Input
            className="font-mono"
            id={`${skill.key}-id`}
            onChange={handleId}
            value={skill.id}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${skill.key}-description`}>Description</Label>
        <Textarea
          id={`${skill.key}-description`}
          onChange={handleDescription}
          value={skill.description}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${skill.key}-tags`}>Tags</Label>
        <Input
          id={`${skill.key}-tags`}
          onChange={handleTags}
          placeholder="billing, invoices"
          value={skill.tags}
        />
      </div>
      {removable ? (
        <div>
          <Button onClick={remove} size="sm" variant="outline">
            Remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PublishedCardView({ card }: { card: PublishedCard }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Published as</h3>
      <p className="whitespace-pre-wrap text-sm">{card.description}</p>
      <ul className="flex flex-col gap-3">
        {card.skills.map((skill) => (
          <li
            className="flex flex-col gap-1 rounded-lg border p-3"
            key={skill.id}
          >
            <span className="font-medium text-sm">{skill.name}</span>
            <span className="whitespace-pre-wrap text-muted-foreground text-sm">
              {skill.description}
            </span>
            <div className="flex flex-wrap gap-1">
              {skill.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shows the agent's public card for review once it is published, and the children.
 * Until then it shows the form that publishes it. The text is typed by the owner;
 * it is never read from the agent's instructions.
 */
export function PublishGate({
  agentId,
  children,
}: {
  agentId: string;
  children: ReactNode;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState<SkillDraft[]>(() => [
    emptySkill(newKey()),
  ]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    setDescription("");
    setSkills([emptySkill(newKey())]);
    setError(null);
    fetchCard(agentId).then(
      (card) => {
        if (current) {
          setLoad({ card, status: "ready" });
        }
      },
      (caught: unknown) => {
        if (current) {
          setLoad({ message: errorMessage(caught), status: "error" });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [agentId]);

  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setDescription(event.target.value);
    },
    []
  );

  const updateSkill = useCallback((next: SkillDraft) => {
    setSkills((previous) =>
      previous.map((skill) => (skill.key === next.key ? next : skill))
    );
  }, []);

  const removeSkill = useCallback((key: string) => {
    setSkills((previous) => previous.filter((skill) => skill.key !== key));
  }, []);

  const addSkill = useCallback(() => {
    setSkills((previous) => [...previous, emptySkill(newKey())]);
  }, []);

  const publish = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().a2a.publish.mutate({
        agentId,
        description: description.trim(),
        skills: toPublishSkills(skills),
      });
      const card = await fetchCard(agentId);
      setLoad({ card, status: "ready" });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, description, skills]);

  if (load.status === "loading") {
    return (
      <p className="text-muted-foreground text-sm">Loading the public card.</p>
    );
  }
  if (load.status === "error") {
    return <p className="text-destructive text-sm">{load.message}</p>;
  }

  const loaded = load.card;
  if (loaded !== null && loaded.unpublishedAt === null) {
    return (
      <div className="flex flex-col gap-4">
        <PublishedCardView card={loaded} />
        {children}
      </div>
    );
  }

  const problem = publishProblem(description, skills);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{FORM_NOTE}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`publish-description-${agentId}`}>Description</Label>
        <Textarea
          id={`publish-description-${agentId}`}
          onChange={handleDescription}
          value={description}
        />
        <p className="text-muted-foreground text-xs">
          Up to {DESCRIPTION_MAX} characters.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-sm">Skills</h3>
        {skills.map((skill) => (
          <SkillRow
            key={skill.key}
            onChange={updateSkill}
            onRemove={removeSkill}
            removable={skills.length > SKILLS_MIN}
            skill={skill}
          />
        ))}
        <div>
          <Button
            disabled={skills.length >= SKILLS_MAX}
            onClick={addSkill}
            size="sm"
            variant="outline"
          >
            Add skill
          </Button>
        </div>
      </div>
      {problem !== null && (
        <p className="text-muted-foreground text-sm">{problem}</p>
      )}
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
      <div>
        <Button disabled={pending || problem !== null} onClick={publish}>
          Publish
        </Button>
      </div>
    </div>
  );
}
