// One line per state change on stdout, errors on stderr. The daemon is a
// service whose output is read from journalctl.

const PREFIX = "harbourmaster";

export interface Logger {
  error: (message: string) => void;
  info: (message: string) => void;
}

export const consoleLogger: Logger = {
  error: (message) => {
    process.stderr.write(`[${PREFIX}] ${message}\n`);
  },
  info: (message) => {
    process.stdout.write(`[${PREFIX}] ${message}\n`);
  },
};

/** A logger that keeps every line, for tests. */
export const collectingLogger = (lines: string[]): Logger => ({
  error: (message) => {
    lines.push(message);
  },
  info: (message) => {
    lines.push(message);
  },
});
