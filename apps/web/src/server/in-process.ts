// Dispatches a request for this deployment's own origin to the app, in the same
// isolate. A Worker cannot fetch its own hostname, so a message between two
// workspaces on one deployment goes this way. `server.ts` owns the Hono app and
// imports `compose.ts`, so `compose.ts` cannot import `server.ts`: `server.ts`
// hands its `app.fetch` over here at load, and the transport reads it back.
// The only state is that one function, set once at load and the same for every
// request.

export type Dispatch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

let dispatch: Dispatch | undefined;

/** Called once by `server.ts` with the app's `fetch`. */
export const setInProcessDispatch = (next: Dispatch): void => {
  dispatch = next;
};

/**
 * A fetch for the app's own origin, or undefined before `server.ts` has set
 * one (a test, a script). `defer` keeps work the request leaves behind alive,
 * as `waitUntil` does for a request that came in from outside.
 */
export const inProcessFetch = (
  env: Env,
  defer?: (work: Promise<void>) => void
): ((request: Request) => Promise<Response>) | undefined => {
  if (!dispatch) {
    return;
  }
  const handle = dispatch;
  const waitUntil = (work: Promise<unknown>): void => {
    const settled = work.then(
      () => undefined,
      () => undefined
    );
    defer?.(settled);
  };
  return async (request) =>
    await handle(request, env, {
      passThroughOnException: () => undefined,
      props: {},
      waitUntil,
    } as ExecutionContext);
};
