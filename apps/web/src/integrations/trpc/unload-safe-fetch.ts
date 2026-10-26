// A page that is being unloaded aborts its in-flight requests, and fetch
// rejects them with "Failed to fetch". That reaches the console as a
// TRPCClientError on a page nobody sees any more, for example when the
// pending-session gate reloads the page after activating an organisation.
// While the page is unloading, a failed request stays pending instead.
type FetchArgs = Parameters<typeof fetch>;

interface PageEvents {
  addEventListener: (
    type: "pagehide" | "pageshow",
    listener: () => void
  ) => void;
}

export function createUnloadSafeFetch(
  page: PageEvents,
  base: (...args: FetchArgs) => Promise<Response>
) {
  let unloading = false;
  page.addEventListener("pagehide", () => {
    unloading = true;
  });
  // A page restored from the back/forward cache is live again.
  page.addEventListener("pageshow", () => {
    unloading = false;
  });
  return async (...args: FetchArgs): Promise<Response> => {
    try {
      return await base(...args);
    } catch (error) {
      if (unloading) {
        return new Promise<Response>(() => undefined);
      }
      throw error;
    }
  };
}
