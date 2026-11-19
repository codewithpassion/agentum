import type { JobSentence, ProposedTrigger } from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { requireWriter } from "./automation-access.ts";
import { notFound } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { JobDrafter } from "./job-drafting/draft.ts";
import type { Principal } from "./workspaces.ts";

const JOBS_READ = "jobs.read";
const JOBS_WRITE = "jobs.write";
const JOBS_KIND = "jobs";

/** The longest description of a job the model reads. */
export const JOB_TEXT_MAX = 2000;

export const forAgentInputSchema = z.strictObject({
  agentId: z.string().min(1),
});

export const draftInputSchema = z.strictObject({
  agentId: z.string().min(1),
  text: z.string().trim().min(1).max(JOB_TEXT_MAX),
});

export const runNowInputSchema = z.strictObject({
  jobId: z.string().min(1),
});

/**
 * Stub: a workspace with no jobs, a model-backed draft, and a run-now
 * that finds no job. The Jobs service task reads the real rows.
 */
export const createJobsService = ({ drafter }: { drafter: JobDrafter }) => {
  const forAgent = (
    principal: Principal,
    agentId: string
  ): Promise<JobSentence[]> => {
    const workspaceId = readableWorkspace(principal, JOBS_READ);
    authorize(principal, JOBS_READ, {
      id: agentId,
      kind: JOBS_KIND,
      workspaceId,
    });
    return Promise.resolve([]);
  };

  const list = (principal: Principal): Promise<JobSentence[]> => {
    const workspaceId = readableWorkspace(principal, JOBS_READ);
    authorize(principal, JOBS_READ, { kind: JOBS_KIND, workspaceId });
    return Promise.resolve([]);
  };

  const draft = (
    principal: Principal,
    agentId: string,
    text: string
  ): Promise<ProposedTrigger> => {
    const workspaceId = readableWorkspace(principal, JOBS_WRITE);
    requireWriter(principal, JOBS_WRITE);
    authorize(principal, JOBS_WRITE, {
      id: agentId,
      kind: JOBS_KIND,
      workspaceId,
    });
    return drafter.draft(principal, agentId, text);
  };

  const runNow = (
    principal: Principal,
    jobId: string
  ): Promise<{ runId: string }> => {
    const workspaceId = readableWorkspace(principal, JOBS_WRITE);
    requireWriter(principal, JOBS_WRITE);
    authorize(principal, JOBS_WRITE, {
      id: jobId,
      kind: JOBS_KIND,
      workspaceId,
    });
    return Promise.reject(notFound("Job not found"));
  };

  return { draft, forAgent, list, runNow };
};

export type JobsService = ReturnType<typeof createJobsService>;
