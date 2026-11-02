import {
  useClerk,
  useOrganizationList,
  useSession,
} from "@clerk/tanstack-react-start";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import {
  CHOOSE_ORGANIZATION_PATH,
  pickerPath,
  pickerTarget,
} from "./picker-redirect";
import { soleWorkspaceOrgId, type WorkspaceRow } from "./sole-organization";

// `/accept-invitation` finishes a pending session itself: it activates the
// organisation that invited the person, which the gate must not pre-empt.
const OWN_PENDING_PAGES = ["/accept-invitation"];

// A user who signs in with no active organisation gets a pending session with
// the `choose-organization` task, and the rest of the app treats that session
// as signed out. An Agent Task sign-in on the production instance ends up
// there. Nobody is at the keyboard to pick, so a person with exactly one
// workspace gets it activated here. Only organisations with a `workspaces` row
// count, and the server says which those are. Everyone else goes to our own
// picker at `/choose-organization`, which keeps the page they asked for.
export function PendingSessionGate() {
  const { isLoaded, session } = useSession();
  const { pathname } = useLocation();
  if (
    isLoaded &&
    session?.status === "pending" &&
    session.currentTask?.key === "choose-organization" &&
    !OWN_PENDING_PAGES.includes(pathname)
  ) {
    return <ResolveChooseOrganization />;
  }
  return null;
}

type Mine = WorkspaceRow[] | "failed" | undefined;

function ResolveChooseOrganization() {
  const { pathname } = useLocation();
  const clerk = useClerk();
  const { isLoaded, setActive } = useOrganizationList();
  const [mine, setMine] = useState<Mine>(undefined);
  const started = useRef(false);
  const onPicker = pathname === CHOOSE_ORGANIZATION_PATH;

  useEffect(() => {
    let current = true;
    getTrpc()
      .workspaces.mine.query()
      .then((rows) => current && setMine(rows))
      .catch(() => current && setMine("failed"));
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (mine === undefined || !isLoaded || started.current) {
      return;
    }
    const organizationId =
      mine === "failed" ? undefined : soleWorkspaceOrgId(mine);
    const here = `${window.location.pathname}${window.location.search}`;
    if (!organizationId) {
      started.current = true;
      if (!onPicker) {
        window.location.assign(pickerPath(here));
      }
      return;
    }
    started.current = true;
    // Read before setActive, which moves the page to the task URL itself.
    const target = onPicker
      ? pickerTarget(
          new URLSearchParams(window.location.search).get("redirect") ??
            undefined
        )
      : window.location.href;
    setActive({ organization: organizationId })
      .then(() => {
        // setActive can resolve with the server still pending (it skips the
        // server call in an unfocused tab). Reloading then would loop, so the
        // session is left for the picker.
        if (clerk.session?.status !== "pending") {
          // A full load so the server sees the active organisation.
          window.location.assign(target);
        }
      })
      .catch(() => {
        if (!onPicker) {
          window.location.assign(pickerPath(here));
        }
      });
  }, [clerk, isLoaded, mine, onPicker, setActive]);

  return null;
}
