// An install script is a POSIX `sh` file with this placeholder where the
// server's origin goes. The route fills it in per request.

export const ORIGIN_PLACEHOLDER = "@@HM_ORIGIN@@";

/** The script with this deployment's origin in it. `origin` has no trailing slash. */
export const renderInstallScript = (template: string, origin: string): string =>
  template.replaceAll(ORIGIN_PLACEHOLDER, origin);
