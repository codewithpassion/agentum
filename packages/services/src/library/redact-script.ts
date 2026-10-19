// The Log keeps the script of every library `bash` call. A `curl` line in it can
// carry a token in a header, a `-u` login, a `-d` body or a URL query, and the
// Log must not hold those. This blanks them. It is a guard for the usual
// spellings of curl, not a parser: a secret that a script builds in a variable
// is not seen here, and the shell never gets the agent's workspace secrets
// anyway.

const CURL = /\bcurl\b/;
const URL_QUERY = /(https?:\/\/[^\s"'?#]+)\?[^\s"'#]*/gi;
const URL_USERINFO = /(https?:\/\/)[^\s/@"']+@/gi;
const QUOTED_HEADER =
  /((?:^|\s)(?:-H|--header)(?:\s+|=))(["'])([^"':]+):[^"']*\2/g;
const BARE_HEADER = /((?:^|\s)(?:-H|--header)(?:\s+|=))([^\s"':]+):\S*/g;
const VALUE_OPTION =
  /((?:^|\s)(?:-u|--user|-b|--cookie|-d|--data|--data-raw|--data-binary|--data-urlencode|--data-ascii|--json)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/g;
const REDACTED = "[redacted]";

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

const redactCurl = (command: string): string =>
  command
    .replace(QUOTED_HEADER, `$1$2$3: ${REDACTED}$2`)
    .replace(BARE_HEADER, `$1$2: ${REDACTED}`)
    .replace(VALUE_OPTION, `$1${REDACTED}`);

/** The script with the secrets a curl command can carry blanked. Other commands are left as typed. */
export const redactScript = (script: string): string =>
  commandsOf(script)
    .map((command) => (CURL.test(command) ? redactCurl(command) : command))
    .join("\n")
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_QUERY, `$1?${REDACTED}`);
