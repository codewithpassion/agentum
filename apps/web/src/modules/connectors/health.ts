import type { Connector } from "./schema";
import { connectorServerName } from "./usability";

/**
 * Reading a session's `session.error` text for "this connector's credentials
 * were rejected". Deliberately conservative: a connector's status drives the
 * whole re-authorize prompt in the UI, so an unrelated model or tool failure
 * must never flip it.
 *
 * Two things have to hold. The message must name the connector - by the server
 * name we registered, its URL, or that URL's host, none of which appear in an
 * error about anything else - and it must blame credentials rather than, say,
 * a timeout or a bad tool argument.
 */

const AUTH_SIGNAL =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?(?:token|grant|client|credential)|auth(?:entication|orization)[ _-]?(?:failed|error|required|expired)|(?:token|credential)s?[^.]{0,24}(?:expired|invalid|rejected|revoked|missing)|(?:expired|invalid|rejected|revoked)[^.]{0,24}(?:token|credential)|re-?authoriz|re-?authenticat/i;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** Whether `message` names this connector at all. */
const namesConnector = (message: string, connector: Connector): boolean => {
  if (message.includes(connectorServerName(connector))) {
    return true;
  }
  if (message.includes(connector.url)) {
    return true;
  }
  const host = hostOf(connector.url);
  return host !== null && message.includes(host);
};

/** The connectors this error blames, out of the ones the agent has attached. */
export const connectorsFailingAuth = (
  message: string,
  connectors: readonly Connector[]
): Connector[] => {
  if (!AUTH_SIGNAL.test(message)) {
    return [];
  }
  return connectors.filter((connector) => namesConnector(message, connector));
};
