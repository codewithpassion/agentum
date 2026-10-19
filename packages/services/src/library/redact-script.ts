// The Log keeps the script of every library `bash` call. A `curl` line can carry
// a token in a header, a login, a body or a URL query, in more spellings than a
// pattern can list, so a line that runs curl is not kept at all. It is logged as
// `curl <host> [arguments redacted]`, or `curl [arguments redacted]` when the
// host cannot be read safely. When the script cannot be read with confidence
// (curl behind a variable, a quote or an alias, a here-document, a quote or
// bracket left open across lines) the whole script is replaced. A script
// without the word curl is logged as typed. The shell never holds the agent's
// workspace secrets, which a credential rule adds outside it.

const ANY_CURL = /curl/gi;
const HAS_CURL = /curl/i;
/** `curl` where a command starts: after a separator, a keyword, or a short list of wrappers. */
const COMMAND_CURL =
  /(?:^|[|&;({`]|\$\(|\b(?:then|do|else|elif|if|while|until|time|exec|command|sudo|xargs(?:\s+-\S+)*)\s)\s*(?:\S*\/)?curl(?=\s|$|[;&|)`])/gim;
const HEREDOC = /<</;
const URL_AUTHORITY = /https?:\/\/([^\s"'`/?#\\]*)/i;
const SAFE_AUTHORITY = /^[A-Za-z0-9.[\]:-]+$/;
const PORT = /:\d*$/;
const WHOLE_SCRIPT = "[script redacted: contains curl]";
const NO_HOST = "curl [arguments redacted]";

/** The lines of one shell command: a trailing backslash joins a line to the next. */
const commandsOf = (script: string): string[] => {
  const commands: string[] = [];
  let open = false;
  for (const line of script.split("\n")) {
    if (open) {
      commands[commands.length - 1] += `\n${line}`;
    } else {
      commands.push(line);
    }
    open = line.endsWith("\\");
  }
  return commands;
};

type Quote = "'" | '"' | null;

/** The quote state after `char`. Inside single quotes only the closing quote counts. */
const quoteAfter = (quote: Quote, char: string): Quote => {
  if (quote === null) {
    return char === "'" || char === '"' ? char : null;
  }
  return char === quote ? null : quote;
};

/** Whether every quote and bracket the command opens is closed in it. */
const isBalanced = (command: string): boolean => {
  let quote: Quote = null;
  let depth = 0;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote === null && (char === "(" || char === ")")) {
      depth += char === "(" ? 1 : -1;
    } else {
      quote = quoteAfter(quote, char);
    }
  }
  return quote === null && depth === 0;
};

/** The host of the first http(s) URL in the command, or null when it is not plainly one. */
const hostOf = (command: string): string | null => {
  const authority = URL_AUTHORITY.exec(command)?.[1];
  if (authority === undefined || !SAFE_AUTHORITY.test(authority)) {
    return null;
  }
  const host = authority.replace(PORT, "");
  return host === "" ? null : host.toLowerCase();
};

const summaryOf = (command: string): string => {
  const host = hostOf(command);
  return host === null ? NO_HOST : `curl ${host} [arguments redacted]`;
};

/** The script as the Log may keep it. */
export const redactScript = (script: string): string => {
  const mentions = script.match(ANY_CURL)?.length ?? 0;
  if (mentions === 0) {
    return script;
  }
  const commands = commandsOf(script);
  const readable =
    !HEREDOC.test(script) &&
    (script.match(COMMAND_CURL)?.length ?? 0) === mentions &&
    commands.every((command) => !HAS_CURL.test(command) || isBalanced(command));
  if (!readable) {
    return WHOLE_SCRIPT;
  }
  return commands
    .map((command) => (HAS_CURL.test(command) ? summaryOf(command) : command))
    .join("\n");
};
