import { createRoot } from "react-dom/client";
import { GuestLanding } from "./components/guests/landing";
import { GuestViewer } from "./components/guests/viewer";
import "./components/guests/guest.css";

const root = document.getElementById("guest-root");
if (root) {
  const segments = window.location.pathname.split("/");
  createRoot(root).render(
    segments[2] === "a" ? (
      <GuestViewer artifactId={decodeURIComponent(segments[3] ?? "")} />
    ) : (
      <GuestLanding token={decodeURIComponent(segments[2] ?? "")} />
    )
  );
}
