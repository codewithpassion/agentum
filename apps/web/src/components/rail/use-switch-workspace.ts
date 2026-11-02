import { useOrganizationList } from "@clerk/tanstack-react-start";
import { useCallback, useState } from "react";
import { switchErrorMessage } from "./workspace-menu-logic.ts";

/**
 * Makes `organizationId` the active organisation and reloads onto `target`
 * (`/desk` unless given).
 * The reload is a full page load because loaders, polls and the rail hold the
 * old workspace's data. A failed switch stays put and reports its error.
 */
export function useSwitchWorkspace(target = "/desk") {
  const { setActive } = useOrganizationList();
  const [error, setError] = useState<string | null>(null);

  /** Switches and reloads. Throws when the switch fails. */
  const activate = useCallback(
    async (organizationId: string) => {
      if (!setActive) {
        throw new Error("Clerk has not loaded yet.");
      }
      await setActive({ organization: organizationId });
      window.location.assign(target);
    },
    [setActive, target]
  );

  /** `activate`, with a failure kept in `error` instead of thrown. */
  const switchTo = useCallback(
    async (organizationId: string) => {
      setError(null);
      try {
        await activate(organizationId);
      } catch (caught) {
        setError(switchErrorMessage(caught));
      }
    },
    [activate]
  );

  return { activate, error, switchTo };
}
