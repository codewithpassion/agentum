import { createRoot } from "react-dom/client";
import { ExportControls } from "../export-controls";

const host = document.getElementById("root");
if (!host) {
  throw new Error("Fixture mount missing");
}
createRoot(host).render(
  <>
    <textarea
      aria-label="Unsaved local edit"
      defaultValue="keep my local edit"
    />
    <ExportControls
      artifactId={host.dataset.artifact ?? ""}
      connected={true}
      kind={host.dataset.kind === "deck" ? "deck" : "document"}
    />
  </>
);
