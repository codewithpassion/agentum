/**
 * The title text of a run that may have started by mail. Pure, so the browser
 * can import it (the task receipt does); the database read is in `mail-subjects.ts`.
 */
import { mailTitle } from "./rail/logic.ts";

/** The first words of the notice a run started by mail begins with. */
const INBOUND_MAIL_PREFIX = "Inbound mail.";

/** The title of a run started by mail that has no subject to show. */
const INBOUND_MAIL_TITLE = "Inbound mail";

/** The mail subject a run is titled by, without its leading Re:, Fwd: or Fw:. Undefined when there is none. */
export const mailTitleOf = (
  subject: string | undefined
): string | undefined => {
  const title = subject === undefined ? "" : mailTitle(subject);
  return title === "" ? undefined : title;
};

/**
 * The text a run is titled by: its mail subject when it has one, else its input
 * text. A run started by mail with no subject reads "Inbound mail", never its notice.
 */
export const runTitleText = (inputText: string, subject?: string): string => {
  const title = mailTitleOf(subject);
  if (title !== undefined) {
    return title;
  }
  return inputText.startsWith(INBOUND_MAIL_PREFIX)
    ? INBOUND_MAIL_TITLE
    : inputText;
};
