/**
 * How the client and the outbox reach a peer. The app supplies one that
 * refuses private addresses and redirects, requires HTTPS outside dev, times
 * out, and dispatches in-process for its own origin. Tests supply a fake peer.
 * It rejects when the request was refused or did not complete.
 */
export type A2aFetch = (url: string, init: RequestInit) => Promise<Response>;
