/** DOM-free binding to the exact document/editor schema; no alternate schema. */
// biome-ignore lint/performance/noBarrelFile: Narrow public bridge keeps consumers on the shared schema and binding versions.
export {
  initProseMirrorDoc,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
export { safeLink, schema, THEME_COLORS } from "./schema";
