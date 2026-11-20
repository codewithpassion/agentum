import { useSyncExternalStore } from "react";
import { SERVER_VIEWER, type Viewer } from "#/lib/time.ts";

const noSubscription = () => () => {
  /* The browser's zone and language do not change while a page is open. */
};

let browserViewer: Viewer | undefined;

const readBrowserViewer = (): Viewer => {
  if (browserViewer === undefined) {
    const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
    browserViewer = { locale, timeZone };
  }
  return browserViewer;
};

const readServerViewer = (): Viewer => SERVER_VIEWER;

/**
 * The viewer's own zone and language. The server and the first browser paint
 * use UTC so hydration matches, then the browser's own take over.
 */
export const useViewer = (): Viewer =>
  useSyncExternalStore(noSubscription, readBrowserViewer, readServerViewer);
