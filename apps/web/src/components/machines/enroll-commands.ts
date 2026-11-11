export const IMAGE_OWNER = "codewithpassion";
const CONTINUATION = " \\\n  ";

const joinArguments = (parts: string[]): string => parts.join(CONTINUATION);

export const agentumCommand = (origin: string, code: string): string =>
  `curl -fsSL ${origin}/install-agentum.sh | AGENTUM_ENROLL_CODE=${code} sh`;

export const agentumInstallCommand = (origin: string): string =>
  `curl -fsSL ${origin}/install-agentum.sh | sh`;

export const AGENTUM_DESKTOP_SECCOMP_NOTE =
  "Run from apps/agentum with packaging/desktop/seccomp.json so Chromium can create its sandbox namespaces.";

export const agentumDockerCommand = (
  origin: string,
  code: string,
  desktop = false
): string =>
  joinArguments([
    `docker run -d --restart unless-stopped --name agentum${desktop ? "-desktop" : ""}`,
    ...(desktop
      ? [
          "--shm-size=256m --cap-drop ALL --cap-add SYS_CHROOT",
          "--security-opt no-new-privileges",
          "--security-opt seccomp=packaging/desktop/seccomp.json",
        ]
      : []),
    `-v agentum${desktop ? "-desktop" : ""}:/var/lib/agentum`,
    `-e AGENTUM_ENROLL_CODE=${code}`,
    `ghcr.io/${IMAGE_OWNER}/agentum:${desktop ? "desktop" : "latest"}`,
    `--url ${origin}`,
  ]);
