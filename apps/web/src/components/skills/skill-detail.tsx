import { useCallback, useEffect, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { Markdown } from "#/components/workspace/markdown";
import type {
  SkillAgentRef,
  SkillDetail as SkillDetailView,
  SkillFile,
  SkillVersion,
} from "#/lib/api";
import { cx } from "#/lib/cx";
import { formatBytes, formatDay, formatTime } from "#/lib/format";
import { useApi } from "#/lib/workspace-context";
import { SKILL_MD_PATH } from "#/modules/skills/validate";
import { authorLabel, SkillSyncLine } from "./skill-status";
import { withoutFrontmatter } from "./skill-template";

/**
 * Everything about one skill on one screen (plan 5e): what it says, what it is
 * made of, every version that ever existed and who wrote it, who may use it,
 * and the three things a human can do to it.
 */

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "muted";
}) {
  return (
    <p
      className="m-0 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-xs"
      style={{
        color: tone === "danger" ? "var(--ws-danger)" : "var(--ws-muted)",
      }}
    >
      {children}
    </p>
  );
}

/** SKILL.md, rendered the way the wiki renders a page. */
function SkillDocument({ slug, version }: { slug: string; version: number }) {
  const api = useApi();

  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .readSkillFile(slug, version, SKILL_MD_PATH)
      .then((content) => {
        if (live) {
          setBody(content);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(messageOf(cause, "Failed to read SKILL.md."));
        }
      });
    return () => {
      live = false;
    };
  }, [api, slug, version]);

  if (error) {
    return <Notice tone="danger">{error}</Notice>;
  }
  return (
    <div data-testid="skill-document">
      {body === null ? (
        <p className="m-0 text-[var(--ws-muted)] text-sm">Loading…</p>
      ) : (
        <Markdown anchors body={withoutFrontmatter(body)} />
      )}
    </div>
  );
}

function FileRow({
  file,
  onView,
  slug,
  version,
  viewing,
}: {
  file: SkillFile;
  onView: (path: string) => void;
  slug: string;
  version: number;
  viewing: boolean;
}) {
  const api = useApi();

  const view = useCallback(() => onView(file.path), [file.path, onView]);

  return (
    <li className="flex items-center gap-2 rounded-lg border border-[var(--ws-line)] px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
        {file.path}
      </span>
      <span className="shrink-0 text-[var(--ws-muted)] text-xs">
        {formatBytes(file.size)}
      </span>
      <Button onClick={view} size="sm">
        {viewing ? "Hide" : "View"}
      </Button>
      <a
        className="ws-focus inline-flex h-7 shrink-0 items-center rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2.5 font-medium text-[var(--ws-text)] text-xs no-underline hover:bg-[var(--ws-surface-hover)]"
        download={file.path}
        href={api.skillFileUrl(slug, version, file.path)}
      >
        Download
      </a>
    </li>
  );
}

function AssignedAgents({ agents }: { agents: SkillAgentRef[] }) {
  if (agents.length === 0) {
    return (
      <Notice tone="muted">
        No agents hold this skill yet. Assign it from an agent's settings.
      </Notice>
    );
  }

  return (
    <ul
      className="m-0 flex list-none flex-wrap gap-2 p-0"
      data-testid="skill-agents"
    >
      {agents.map((agent) => (
        <li
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ws-line)] px-2 py-1 text-xs"
          key={agent.id}
        >
          <Avatar color={agent.avatar} name={agent.name} size="sm" />
          <span>{agent.name}</span>
          <span className="text-[var(--ws-muted)]">
            {agent.pinnedVersion === null
              ? "latest"
              : `pinned v${agent.pinnedVersion}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function VersionRow({
  agentNames,
  onSelect,
  selected,
  version,
}: {
  agentNames: ReadonlyMap<string, string>;
  onSelect: (version: number) => void;
  selected: boolean;
  version: SkillVersion;
}) {
  const select = useCallback(
    () => onSelect(version.version),
    [onSelect, version.version]
  );

  return (
    <li>
      <button
        className={cx(
          "ws-focus w-full rounded-lg px-3 py-2 text-left",
          selected
            ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
            : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
        )}
        onClick={select}
        type="button"
      >
        <span className="block font-medium text-[13px] text-[var(--ws-text)]">
          v{version.version}
          {version.changelog ? ` — ${version.changelog}` : ""}
        </span>
        <span className="block text-[var(--ws-muted)] text-xs">
          {authorLabel(version.createdBy, agentNames)} ·{" "}
          {formatDay(version.createdAt)} {formatTime(version.createdAt)}
          {version.anthropicVersion ? "" : " · not mirrored"}
        </span>
      </button>
    </li>
  );
}

export function SkillDetail({
  agentNames,
  agents,
  detail,
  onChanged,
  onEdit,
  onRemoved,
  onSelectVersion,
}: {
  agentNames: ReadonlyMap<string, string>;
  agents: SkillAgentRef[];
  detail: SkillDetailView;
  onChanged: () => Promise<void>;
  onEdit: () => void;
  /** Carries Anthropic's complaint when its mirror could not be deleted. */
  onRemoved: (anthropicError: string | null) => Promise<void>;
  onSelectVersion: (version: number | null) => void;
}) {
  const api = useApi();

  const { files, skill, version, versions } = detail;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [viewing, setViewing] = useState<{
    content: string;
    path: string;
  } | null>(null);

  const viewFile = useCallback(
    (path: string) => {
      if (viewing?.path === path) {
        setViewing(null);
        return;
      }
      setError(null);
      api
        .readSkillFile(skill.slug, version.version, path)
        .then((content) => setViewing({ content, path }))
        .catch((cause: unknown) =>
          setError(messageOf(cause, "Failed to read that file."))
        );
    },
    [api, skill.slug, version.version, viewing]
  );

  const retry = useCallback(() => {
    setBusy(true);
    setError(null);
    api
      .retrySkillSync(skill.slug)
      .then(async (synced) => {
        setNotice(
          synced.syncStatus === "synced"
            ? "Mirrored at Anthropic."
            : (synced.syncError ?? "Still not mirrored.")
        );
        await onChanged();
      })
      .catch((cause: unknown) =>
        setError(messageOf(cause, "The retry did not work."))
      )
      .finally(() => setBusy(false));
  }, [api, onChanged, skill.slug]);

  const askRemove = useCallback(() => setRemoveOpen(true), []);
  const cancelRemove = useCallback(() => setRemoveOpen(false), []);
  const confirmRemove = useCallback(async () => {
    // The local delete stands even when Anthropic refused to drop its copy, so
    // that failure travels with the navigation rather than being swallowed.
    const removed = await api.deleteSkill(skill.slug);
    setRemoveOpen(false);
    await onRemoved(removed.anthropicError);
  }, [api, onRemoved, skill.slug]);

  const viewingLatest = version.version === skill.latestVersion;
  const backToLatest = useCallback(
    () => onSelectVersion(null),
    [onSelectVersion]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <h2 className="m-0 font-semibold text-lg">{skill.name}</h2>
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            {skill.description}
          </p>
          <p className="m-0 flex flex-wrap items-center gap-2 text-[var(--ws-muted)] text-xs">
            <span data-testid="skill-version">
              Viewing v{version.version} of {skill.latestVersion}
            </span>
            <span aria-hidden="true">·</span>
            <span>by {authorLabel(skill.createdBy, agentNames)}</span>
            <span aria-hidden="true">·</span>
            <SkillSyncLine skill={skill} />
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          {viewingLatest ? null : (
            <Button onClick={backToLatest}>Back to latest</Button>
          )}
          {skill.syncStatus === "error" ? (
            <Button disabled={busy} onClick={retry}>
              Retry sync
            </Button>
          ) : null}
          <Button disabled={busy} onClick={askRemove} variant="danger">
            Delete
          </Button>
        </div>

        {notice ? <Notice tone="muted">{notice}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {skill.syncError ? (
          <Notice tone="danger">{skill.syncError}</Notice>
        ) : null}
        {skill.syncStatus === "unsynced" ? (
          <Notice tone="muted">
            Not mirrored at Anthropic yet, so it reaches no session yet. It is a
            perfectly good local skill in the meantime.
          </Notice>
        ) : null}

        <Section title="SKILL.md">
          <SkillDocument slug={skill.slug} version={version.version} />
        </Section>

        <Section title="Files">
          <ul className="m-0 list-none space-y-1 p-0" data-testid="skill-files">
            {files.map((file) => (
              <FileRow
                file={file}
                key={file.path}
                onView={viewFile}
                slug={skill.slug}
                version={version.version}
                viewing={viewing?.path === file.path}
              />
            ))}
          </ul>
          {viewing ? (
            <pre
              className="m-0 overflow-x-auto rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-3 text-xs"
              data-testid="skill-file-content"
            >
              {viewing.content}
            </pre>
          ) : null}
        </Section>

        <Section title="History">
          <ul
            className="m-0 list-none space-y-1 p-0"
            data-testid="skill-versions"
          >
            {[...versions]
              .sort((left, right) => right.version - left.version)
              .map((row) => (
                <VersionRow
                  agentNames={agentNames}
                  key={row.id}
                  onSelect={onSelectVersion}
                  selected={row.version === version.version}
                  version={row}
                />
              ))}
          </ul>
        </Section>

        <Section title="Agents">
          <AssignedAgents agents={agents} />
        </Section>
      </div>

      <ConfirmDialog
        confirmLabel="Delete skill"
        message={`Delete ${skill.slug}? Every agent using it is unassigned and resynced without it, every version is deleted at Anthropic, and the files here go with them.`}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
        open={removeOpen}
        title="Delete skill"
      />
    </div>
  );
}
