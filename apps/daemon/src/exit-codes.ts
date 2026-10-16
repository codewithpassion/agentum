// What the `harbourmaster` binary's exit status means. The systemd unit reads
// code 3 to decide never to restart: a rejected credential cannot be fixed by
// trying again, while any other failure is a crash that should be restarted.

export const EXIT_OK = 0;
/** Anything that went wrong and may go right next time. */
export const EXIT_FAILURE = 1;
/** The unit is installed but the user has no lingering, so it dies at logout. */
export const EXIT_LINGER_MISSING = 2;
/** The relay rejected the credential: enrol the machine again. */
export const EXIT_CREDENTIAL_REJECTED = 3;
