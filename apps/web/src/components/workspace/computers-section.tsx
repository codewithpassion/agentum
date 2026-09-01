import { useUser } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { ComputerHostStatusDot } from "#/components/computers/computer-host-status";
import { COMPUTER_HOST_KIND_LABELS, lastSeenLabel } from "#/lib/computer-hosts";
import { useComputerHosts } from "#/lib/use-computer-hosts";
import { useWorkspaceSlug } from "#/lib/workspace-context";
import { SectionHint, SidebarSection } from "./sidebar-section";

/**
 * The computer hosts in the sidebar, next to Connectors and Skills: every host
 * with its health, leading to the host's own page, which is where adding,
 * testing and removing live.
 */

export const COMPUTERS_SECTION = "computers";

const rowClass =
  "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--ws-muted)] no-underline hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]";

export function ComputersSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (sectionKey: string) => void;
}) {
  const workspaceSlug = useWorkspaceSlug();

  const { isSignedIn } = useUser();
  const { hosts } = useComputerHosts(isSignedIn === true);

  return (
    <SidebarSection
      actions={
        <Link
          aria-label="Add a computer host"
          className="ws-focus inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ws-muted)] no-underline hover:bg-[var(--ws-surface-hover)] hover:text-[var(--ws-text)]"
          params={{ workspaceSlug }}
          title="Add a computer host"
          to="/w/$workspaceSlug/computers"
        >
          <span aria-hidden="true">＋</span>
        </Link>
      }
      expanded={expanded}
      label="Computers"
      onToggle={onToggle}
      sectionKey={COMPUTERS_SECTION}
    >
      {hosts.length === 0 ? (
        <SectionHint>No computer hosts yet.</SectionHint>
      ) : (
        hosts.map((host) => (
          <Link
            className={rowClass}
            data-testid="sidebar-computer-host"
            key={host.id}
            params={{ hostId: host.id, workspaceSlug }}
            title={`${host.name} - ${COMPUTER_HOST_KIND_LABELS[host.kind]} · ${lastSeenLabel(host.lastSeenAt)}`}
            to="/w/$workspaceSlug/computers/$hostId"
          >
            <ComputerHostStatusDot status={host.status} />
            <span className="truncate">{host.name}</span>
          </Link>
        ))
      )}
    </SidebarSection>
  );
}
