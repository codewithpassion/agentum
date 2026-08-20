import { useUser } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ConnectorSetupDialog } from "#/components/connectors/connector-setup-dialog";
import { ConnectorStatusDot } from "#/components/connectors/connector-status";
import { Button } from "#/components/ui/button";
import type { Connector } from "#/lib/api";
import { cx } from "#/lib/cx";
import { useConnectors } from "#/lib/use-connectors";
import { SectionHint, SidebarSection } from "./sidebar-section";

/**
 * The connectors directory in the sidebar (plan 4d, first row): every connector
 * with its health, and the way in to adding one. A row leads to the connector's
 * own page, which is where everything else about it lives.
 */

export const CONNECTORS_SECTION = "connectors";

const rowClass =
  "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--ws-muted)] no-underline hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]";

export function ConnectorsSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (sectionKey: string) => void;
}) {
  const { isSignedIn } = useUser();
  const { connectors, reload } = useConnectors(isSignedIn === true);
  const [addOpen, setAddOpen] = useState(false);

  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  // Navigating to the new connector is the page's job; here the list is enough.
  const onAdded = useCallback(
    async (_connector: Connector) => {
      await reload();
    },
    [reload]
  );

  return (
    <>
      <SidebarSection
        actions={
          <Button
            aria-label="Add connector"
            onClick={openAdd}
            size="icon"
            title="Add connector"
            variant="ghost"
          >
            <span aria-hidden="true">＋</span>
          </Button>
        }
        expanded={expanded}
        label="Connectors"
        onToggle={onToggle}
        sectionKey={CONNECTORS_SECTION}
      >
        {connectors.length === 0 ? (
          <SectionHint>No connectors yet.</SectionHint>
        ) : (
          connectors.map((connector) => (
            <Link
              className={cx(rowClass)}
              data-testid="sidebar-connector"
              key={connector.id}
              params={{ connectorId: connector.id }}
              title={`${connector.name} - ${connector.url}`}
              to="/connectors/$connectorId"
            >
              <ConnectorStatusDot status={connector.status} />
              <span className="truncate">{connector.name}</span>
            </Link>
          ))
        )}
      </SidebarSection>

      <ConnectorSetupDialog
        connector={null}
        onClose={closeAdd}
        onDone={onAdded}
        open={addOpen}
      />
    </>
  );
}
