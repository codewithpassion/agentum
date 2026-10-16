// URL of the OAuth connect flow. A plain link starts it, because the flow is a
// full-page redirect to the connector's authorisation server.
export type ConnectAs = "user" | `agent:${string}`;

export function connectHref({
  as,
  connectorId,
  returnTo,
}: {
  as: ConnectAs;
  connectorId: string;
  returnTo: string;
}): string {
  const query = `as=${encodeURIComponent(as)}&return_to=${encodeURIComponent(returnTo)}`;
  return `/connect/${encodeURIComponent(connectorId)}?${query}`;
}
