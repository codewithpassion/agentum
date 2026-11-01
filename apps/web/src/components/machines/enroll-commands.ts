export const IMAGE_OWNER = "codewithpassion";
export const HEADLESS_IMAGE = `ghcr.io/${IMAGE_OWNER}/harbourmaster-computer:latest`;
export const DESKTOP_IMAGE = `ghcr.io/${IMAGE_OWNER}/harbourmaster-computer-desktop:latest`;

export const DESKTOP_SECCOMP_NOTE =
  "Chromium needs the seccomp profile packaging/desktop/seccomp.json from the apps/computer folder of the repository. Run this command from inside apps/computer.";

const CONTINUATION = " \\\n  ";

const joinArguments = (parts: string[]): string => parts.join(CONTINUATION);

export const daemonInstallCommand = (origin: string): string =>
  `curl -fsSL ${origin}/install.sh | sh`;

export const daemonCommand = (origin: string, code: string): string =>
  `${daemonInstallCommand(origin)} -s -- --code ${code}`;

export const dockerHeadlessCommand = (origin: string, code: string): string =>
  joinArguments([
    "docker run -d --restart unless-stopped --name hm-computer",
    "-v hm-computer:/var/lib/hm-computer",
    HEADLESS_IMAGE,
    `--url ${origin} --code ${code}`,
  ]);

export const dockerDesktopCommand = (origin: string, code: string): string =>
  joinArguments([
    "docker run -d --restart unless-stopped --name hm-computer-desktop",
    "--shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT",
    "--security-opt no-new-privileges",
    "--security-opt seccomp=packaging/desktop/seccomp.json",
    "-v hm-computer-desktop:/var/lib/hm-computer",
    DESKTOP_IMAGE,
    `--url ${origin} --code ${code}`,
  ]);

export const computerInstallCommand = (origin: string): string =>
  `curl -fsSL ${origin}/install-computer.sh | sh`;

export const binaryCommand = (origin: string, code: string): string =>
  `${computerInstallCommand(origin)} -s -- --code ${code}`;
