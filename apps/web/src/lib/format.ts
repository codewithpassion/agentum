const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;
const MAX_INITIALS = 2;
const WHITESPACE = /\s+/;

export const initialsFor = (name: string): string =>
  name
    .split(WHITESPACE)
    .filter(Boolean)
    .slice(0, MAX_INITIALS)
    .map((word) => word.charAt(0).toUpperCase())
    .join("") || "?";

export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unitIndex]}`;
};

export const formatTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

export const formatDay = (timestamp: number): string =>
  new Date(timestamp).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export const isImage = (mime: string): boolean => mime.startsWith("image/");

const MASK = "••••••••";

/**
 * An agent's MCP URL is a bearer credential, so the token is masked on screen;
 * the copy button still copies the real one.
 */
export const maskMcpUrl = (url: string): string => {
  const lastSlash = url.lastIndexOf("/");
  return lastSlash === -1 ? MASK : `${url.slice(0, lastSlash + 1)}${MASK}`;
};
