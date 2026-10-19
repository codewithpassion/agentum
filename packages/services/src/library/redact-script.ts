// The Log keeps the script of every library `bash` call. A `curl` line in it can
// carry a token in a header, a `-u` login, a `-d` body or a URL query, and the
// Log must not hold those. This blanks them, and also the login and query of
// any http(s) URL in the script. It is a guard for the usual spellings of curl,
// not a parser. Known limits: a secret that a script builds in a variable, a
// body sent on stdin (`-d @-`), and options the shell's curl refuses (`-F`,
// `--oauth2-bearer`) are not seen here. The shell never holds the agent's
// workspace secrets, which a credential rule adds outside it.

const CURL = /\bcurl\b/;
const URL_QUERY = /(https?:\/\/[^\s"'?#]+)\?[^\s"'#]*/gi;
const URL_USERINFO = /(https?:\/\/)[^\s/@"']+@/gi;
// A short option may sit in a cluster (`-sH`) and take its value attached (`-uname:pw`).
const HEADER_OPTION = "(?:^|\\s)(?:-[A-Za-z]*H|--header)(?:\\s+|=)";
const QUOTED_HEADER = new RegExp(
  `(${HEADER_OPTION})(?:"([^":]+):[^"]*"|'([^':]+):[^']*')`,
  "g"
);
const BARE_HEADER = new RegExp(`(${HEADER_OPTION})([^\\s"':]+):\\S*`, "g");
const VALUE_OPTION =
  /((?:^|\s)(?:-[A-Za-z]*[ubd]\s*|--(?:user|cookie|data(?:-raw|-binary|-urlencode|-ascii)?|json)(?:\s+|=)))("[^"]*"|'[^']*'|\S+)/g;
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
    .replace(
      QUOTED_HEADER,
      (_match, option: string, double?: string, single?: string) =>
        double === undefined
          ? `${option}'${single}: ${REDACTED}'`
          : `${option}"${double}: ${REDACTED}"`
    )
    .replace(BARE_HEADER, `$1$2: ${REDACTED}`)
    .replace(VALUE_OPTION, `$1${REDACTED}`);

/** The script with the secrets a curl command can carry blanked. Other commands are left as typed, apart from the login and query of a URL. */
export const redactScript = (script: string): string =>
  commandsOf(script)
    .map((command) => (CURL.test(command) ? redactCurl(command) : command))
    .join("\n")
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_QUERY, `$1?${REDACTED}`);
