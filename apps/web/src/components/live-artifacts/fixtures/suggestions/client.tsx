import { createRoot } from "react-dom/client";
import { Suggestions } from "../../suggestions";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(
  <main>
    <Suggestions artifactId="12345678-1234-4123-8123-123456789abc" canEdit />
  </main>
);
