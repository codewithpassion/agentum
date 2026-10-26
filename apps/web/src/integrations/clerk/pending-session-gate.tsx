import {
  RedirectToTasks,
  useOrganizationList,
  useSession,
} from "@clerk/tanstack-react-start";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { soleOrganizationId } from "./sole-organization";

const CHOOSE_ORGANIZATION_PATH = "/choose-organization";

// A user who signs in with no active organisation gets a pending session with
// the `choose-organization` task, and the rest of the app treats that session
// as signed out. An Agent Task sign-in on the production instance ends up
// there. Nobody is at the keyboard to pick, so a user with exactly one
// organisation gets it activated here. Everyone else goes to the picker.
export function PendingSessionGate() {
  const { isLoaded, session } = useSession();
  if (
    isLoaded &&
    session?.status === "pending" &&
    session.currentTask?.key === "choose-organization"
  ) {
    return <ResolveChooseOrganization />;
  }
  return null;
}

function ResolveChooseOrganization() {
  const { pathname } = useLocation();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });
  const started = useRef(false);
  const organizationId = soleOrganizationId(
    userMemberships.data,
    userMemberships.count
  );
  const onPicker = pathname === CHOOSE_ORGANIZATION_PATH;

  useEffect(() => {
    if (!(isLoaded && organizationId) || started.current) {
      return;
    }
    started.current = true;
    setActive({ organization: organizationId }).then(() => {
      // A full load so the server sees the active organisation.
      window.location.assign(onPicker ? "/" : window.location.href);
    });
  }, [isLoaded, onPicker, organizationId, setActive]);

  if (isLoaded && !organizationId && !onPicker) {
    return <RedirectToTasks />;
  }
  return null;
}
