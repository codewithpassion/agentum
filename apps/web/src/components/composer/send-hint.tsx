import { useEffect, useState } from "react";
import { isMacPlatform, sendShortcutLabel } from "./send-shortcut.ts";

/**
 * Shows the send shortcut. The first render uses the Ctrl label so the server
 * render and the first client render match. The macOS label appears after mount.
 */
export const SendHint = ({ id }: { id?: string }) => {
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(isMacPlatform(navigator.userAgent));
  }, []);

  return (
    <span className="text-muted-foreground text-xs" id={id}>
      {sendShortcutLabel(mac)}
    </span>
  );
};
