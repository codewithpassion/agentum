import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GuestLanding } from "./components/guests/landing";
import { GuestViewer } from "./components/guests/viewer";
import "./components/guests/guest.css";

/** Keep artifact navigation in this document so in-flight cookie rotations
 * finish rather than being cancelled by a full page navigation. */
function GuestApp() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const changed = () => setPath(window.location.pathname);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const segments = path.split("/");
  return segments[2] === "a" ? (
    <GuestViewer
      artifactId={decodeURIComponent(segments[3] ?? "")}
      key={path}
    />
  ) : (
    <GuestLanding token={decodeURIComponent(segments[2] ?? "")} />
  );
}
const root = document.getElementById("guest-root");
if (root) {
  createRoot(root).render(<GuestApp />);
}
