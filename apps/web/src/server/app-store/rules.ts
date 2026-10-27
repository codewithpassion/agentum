import type { AppViewer, StorageArea } from "./types.ts";

// Members write both areas. Live link viewers write only their own viewer area. Snapshot links write nothing.
export function canWrite(viewer: AppViewer, area: StorageArea): boolean {
  if (viewer.kind === "member") {
    return true;
  }
  return viewer.dataMode === "live" && area === "viewer";
}

// The storage key that separates one viewer's data from another's.
export function viewerKey(viewer: AppViewer): string {
  return viewer.kind === "member"
    ? `u:${viewer.userId}`
    : `l:${viewer.shareId}`;
}
