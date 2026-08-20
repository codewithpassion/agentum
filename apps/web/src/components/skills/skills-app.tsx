import { useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { listAgents, type Skill, type SkillVersion } from "#/lib/api";
import { cx } from "#/lib/cx";
import { useSkillDetail, useSkills } from "#/lib/use-skills";
import { SkillCreateForm } from "./skill-create";
import { SkillDetail } from "./skill-detail";
import { SkillDirectory } from "./skill-directory";
import { SkillSyncDot } from "./skill-status";
import { SkillVersionEditor } from "./skill-version-editor";

/**
 * The skills directory and one skill's detail, side by side - the same shape as
 * the wiki and connectors, which is the app's "top-level section" layout.
 *
 * Writing a skill and publishing a version are modes of this route rather than
 * dialogs: a file set does not fit in a modal.
 */

const rowClass = (active: boolean): string =>
  cx(
    "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] no-underline",
    active
      ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
      : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
  );

function SignedOutNotice() {
  return (
    <div className="ws-shell items-center justify-center">
      <p className="m-0 text-[var(--ws-muted)] text-sm">
        <a className="text-[var(--ws-accent)]" href="/login">
          Sign in
        </a>{" "}
        to manage skills.
      </p>
    </div>
  );
}

export function SkillsApp({
  creating = false,
  editing = false,
  slug,
  version,
}: {
  creating?: boolean;
  editing?: boolean;
  slug: string | null;
  version: number | null;
}) {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();

  const { error: listError, reload, skills } = useSkills(signedIn);
  const {
    agents,
    detail,
    error: detailError,
    reload: reloadDetail,
  } = useSkillDetail(slug, version, signedIn);
  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(
    new Map()
  );
  /** Outlives the page it happened on, which is why it lives up here. */
  const [notice, setNotice] = useState<string | null>(null);

  // Agents author skills through the MCP tools; their names come from the
  // agents API rather than from the skills module.
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    listAgents()
      .then((rows) =>
        setAgentNames(new Map(rows.map((agent) => [agent.id, agent.name])))
      )
      .catch(() => setAgentNames(new Map()));
  }, [signedIn]);

  const startNew = useCallback(() => {
    navigate({ search: { new: true }, to: "/skills" });
  }, [navigate]);

  const cancelNew = useCallback(() => {
    navigate({ search: {}, to: "/skills" });
  }, [navigate]);

  const onCreated = useCallback(
    async (created: Skill) => {
      await reload();
      await navigate({ params: { slug: created.slug }, to: "/skills/$slug" });
    },
    [navigate, reload]
  );

  const startEdit = useCallback(() => {
    if (slug) {
      navigate({
        params: { slug },
        search: { edit: true },
        to: "/skills/$slug",
      });
    }
  }, [navigate, slug]);

  const stopEdit = useCallback(() => {
    if (slug) {
      navigate({ params: { slug }, search: {}, to: "/skills/$slug" });
    }
  }, [navigate, slug]);

  const onVersionSaved = useCallback(
    async (_version: SkillVersion) => {
      await reload();
      if (slug) {
        await navigate({ params: { slug }, search: {}, to: "/skills/$slug" });
      }
      await reloadDetail();
    },
    [navigate, reload, reloadDetail, slug]
  );

  const selectVersion = useCallback(
    (next: number | null) => {
      if (slug) {
        navigate({
          params: { slug },
          search: next === null ? {} : { version: next },
          to: "/skills/$slug",
        });
      }
    },
    [navigate, slug]
  );

  const onRemoved = useCallback(
    async (anthropicError: string | null) => {
      setNotice(
        anthropicError === null
          ? null
          : `Deleted here, but Anthropic kept its copy: ${anthropicError}`
      );
      await reload();
      await navigate({ search: {}, to: "/skills" });
    },
    [navigate, reload]
  );

  const refreshAll = useCallback(async () => {
    await reload();
    await reloadDetail();
  }, [reload, reloadDetail]);

  if (isSignedIn === false) {
    return <SignedOutNotice />;
  }

  const error = listError ?? detailError;

  return (
    <div className="ws-shell">
      <nav
        aria-label="Skills"
        className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <Link className="font-semibold text-sm no-underline" to="/">
            ← Agentum
          </Link>
          <Button
            aria-label="New skill"
            onClick={startNew}
            size="icon"
            title="New skill"
            variant="ghost"
          >
            <span aria-hidden="true">＋</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          <h2 className="px-2 pt-1 pb-2 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
            Skills
          </h2>
          {skills.length === 0 ? (
            <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
              No skills yet.
            </p>
          ) : null}
          {skills.map((row) => (
            <Link
              className={rowClass(row.slug === slug)}
              key={row.id}
              params={{ slug: row.slug }}
              to="/skills/$slug"
            >
              <SkillSyncDot status={row.syncStatus} />
              <span className="truncate">{row.name}</span>
              <span className="shrink-0 text-[var(--ws-muted)] text-xs">
                v{row.latestVersion}
              </span>
            </Link>
          ))}
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating ? (
          <SkillCreateForm onCancel={cancelNew} onCreated={onCreated} />
        ) : null}

        {!creating && detail && editing ? (
          <SkillVersionEditor
            baseFiles={detail.files}
            baseVersion={detail.version.version}
            onCancel={stopEdit}
            onSaved={onVersionSaved}
            slug={detail.skill.slug}
          />
        ) : null}

        {!(creating || editing) && detail ? (
          <SkillDetail
            agentNames={agentNames}
            agents={agents}
            detail={detail}
            onChanged={refreshAll}
            onEdit={startEdit}
            onRemoved={onRemoved}
            onSelectVersion={selectVersion}
          />
        ) : null}

        {creating || slug ? null : (
          <SkillDirectory
            agentNames={agentNames}
            onNew={startNew}
            skills={skills}
          />
        )}
      </main>

      {error ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-muted)] text-xs">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
