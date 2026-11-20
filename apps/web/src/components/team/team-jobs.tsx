import type { JobSentence } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";

const EMPTY_TEXT = "No standing jobs yet.";

/** A job as one line: "when: does". Only the parts that are set. */
const jobLine = ({
  does,
  when,
}: Pick<JobSentence, "does" | "when">): string => {
  if (does.trim() === "") {
    return when;
  }
  return when.trim() === "" ? does : `${when}: ${does}`;
};

/** The standing jobs of a team's agents, one line each. */
export function TeamJobs({ jobs }: { jobs: readonly JobSentence[] }) {
  if (jobs.length === 0) {
    return <p className="text-muted-foreground text-sm">{EMPTY_TEXT}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {jobs.map((job) => (
          <li
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-3"
            key={`${job.source}:${job.id}`}
          >
            <p className="font-semibold">{job.agent.name}</p>
            <p className="text-sm">{jobLine(job)}</p>
          </li>
        ))}
      </ul>
      <Link
        className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        to="/jobs"
      >
        All jobs
      </Link>
    </div>
  );
}
