import { useCallback, useEffect, useState } from "react";
import type { AssignedSkill, Skill, SkillAgentRef, SkillDetail } from "./api";
import { useApi } from "./workspace-context";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface SkillsState {
  error: string | null;
  reload: () => Promise<void>;
  skills: Skill[];
}

/** The directory is small and is refetched after any mutation, like connectors. */
export const useSkills = (enabled: boolean): SkillsState => {
  const api = useApi();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      setSkills(await api.listSkills());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load skills."));
    }
  }, [api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, reload, skills };
};

export interface SkillDetailState {
  agents: SkillAgentRef[];
  detail: SkillDetail | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * One skill at one version. `version` null reads the latest, which is also what
 * the detail view falls back to after a new version is published.
 */
export const useSkillDetail = (
  slug: string | null,
  version: number | null,
  enabled: boolean
): SkillDetailState => {
  const api = useApi();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [agents, setAgents] = useState<SkillAgentRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!(enabled && slug)) {
      return;
    }
    setLoading(true);
    try {
      setDetail(await api.getSkill(slug, version ?? undefined));
      setAgents(await api.listSkillAgents(slug));
      setError(null);
    } catch (cause) {
      setDetail(null);
      setError(messageOf(cause, "Failed to load this skill."));
    } finally {
      setLoading(false);
    }
  }, [api, enabled, slug, version]);

  // Switching skills must not leave the previous one's files on screen while
  // the next request is in flight.
  useEffect(() => {
    setAgents([]);
    setDetail(null);
    reload();
  }, [reload]);

  return { agents, detail, error, loading, reload };
};

export interface AgentSkillsState {
  error: string | null;
  reload: () => Promise<void>;
  skills: AssignedSkill[];
}

/** Which skills reach this agent's sessions - the rail chips' source. */
export const useAgentSkills = (
  agentId: string | null,
  enabled: boolean
): AgentSkillsState => {
  const api = useApi();
  const [skills, setSkills] = useState<AssignedSkill[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!(enabled && agentId)) {
      setSkills([]);
      return;
    }
    try {
      setSkills(await api.listAgentSkills(agentId));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load this agent's skills."));
    }
  }, [agentId, api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, reload, skills };
};
