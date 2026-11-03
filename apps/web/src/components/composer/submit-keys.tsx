import { useEffect, useState } from "react";
import { Kbd } from "#/components/ui/kbd.tsx";
import { isMacPlatform, submitKeysLabel } from "./send-shortcut.ts";

/**
 * The small key indicator inside a primary button. The first render says Ctrl
 * so the server and the first client render match, and a Mac gets Cmd after
 * mount. It hides on a narrow or touch screen, which has no such keys.
 */
export const SubmitKeys = () => {
  const [mac, setMac] = useState(false);

  useEffect(() => {
    setMac(isMacPlatform(navigator.userAgent));
  }, []);

  return (
    <Kbd
      aria-hidden="true"
      className="pointer-coarse:hidden bg-primary-foreground/15 text-primary-foreground max-sm:hidden"
      data-testid="submit-keys"
    >
      {submitKeysLabel(mac)}
    </Kbd>
  );
};
