import { useEffect, useState } from "react";
import {
  isMacPlatform,
  sendShortcutLabel,
  TOUCH_SEND_LABEL,
} from "./send-shortcut.ts";

/**
 * Shows how to send. The first render uses the Ctrl label so the server
 * render and the first client render match. After mount a Mac gets the
 * Cmd label and a touch screen (no hover, coarse pointer) says to tap Send.
 */
export const SendHint = ({ id }: { id?: string }) => {
  const [mac, setMac] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    setMac(isMacPlatform(navigator.userAgent));
    setTouch(window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  }, []);

  return (
    <span className="text-muted-foreground text-xs" id={id}>
      {touch ? TOUCH_SEND_LABEL : sendShortcutLabel(mac)}
    </span>
  );
};
