import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";
import { LiveDocument } from "@repo/live-doc";
import { Doc } from "yjs";
import { ExportError } from "./error";
import { verifyPNG } from "./png";

/** Must be bound to the authenticated caller AND artifact before calling an exporter. */
export interface OwnAssets {
  paths: ReadonlySet<string>;
  read: (path: string) => Promise<{ bytes: Uint8Array; mime: string }>;
}
export interface Warning {
  code: string;
  detail: string;
  path: string;
}
export interface Result<T> {
  value: T;
  warnings: Warning[];
}
export const limits = {
  asset: 5_000_000,
  assets: 20_000_000,
  nodes: 20_000,
  output: 32_000_000,
  pixels: 4_000_000,
  snapshot: 16_000_000,
  text: 4_000_000,
} as const;
export function bound(bytes: Uint8Array, max: number) {
  if (!(bytes instanceof Uint8Array) || bytes.length > max || !bytes.length) {
    throw new ExportError("export_byte_limit");
  }
}
export function documentInput(snapshot: Uint8Array, assets: OwnAssets) {
  bound(snapshot, limits.snapshot);
  const doc = new Doc();
  const live = new LiveDocument(doc, { ownBlobUrls: assets.paths });
  try {
    live.applyUpdate(snapshot, "export");
    const json = live.json();
    portableStrings(json);
    return json;
  } finally {
    live.destroy();
    doc.destroy();
  }
}
export function deckInput(snapshot: Uint8Array, assets: OwnAssets) {
  bound(snapshot, limits.snapshot);
  const doc = new Doc();
  const deck = new Deck(doc, richTextCodec, {
    ownsBlob: (path) => assets.paths.has(path),
  });
  try {
    deck.applyUpdate(snapshot);
    const scene = {
      slides: deck.ids().map((id) => deck.read(id).slide),
      theme: deck.theme(),
    };
    portableStrings(scene);
    return scene;
  } finally {
    deck.destroy();
    doc.destroy();
  }
}
export function escapeHTML(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(result);
}
function verifiedImage(mime: string, bytes: Uint8Array) {
  // PNG only: reject active SVG and mismatched MIME. IHDR bounds checked before any library sees it.
  if (
    mime !== "image/png" ||
    bytes.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  ) {
    throw new ExportError("export_asset_type");
  }
  const view = new DataView(bytes.buffer);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49_48_44_52) {
    throw new ExportError("export_asset_header");
  }
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    !(width && height) ||
    width > 8192 ||
    height > 8192 ||
    width * height > limits.pixels
  ) {
    throw new ExportError("export_asset_dimensions");
  }
  verifyPNG(bytes, width, height);
  return {
    bytes,
    data: `data:image/png;base64,${base64(bytes)}`,
    height,
    mime: "image/png" as const,
    width,
  };
}
const ownPath = /^\/files\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
export function assetLoader(port: OwnAssets) {
  let total = 0;
  let references = 0;
  let pending = Promise.resolve();
  let failure: unknown;
  const cache = new Map<
    string,
    Promise<{
      bytes: Uint8Array;
      mime: "image/png";
      width: number;
      height: number;
      data: string;
    }>
  >();
  return (path: string) => {
    if (!ownPath.test(path) || path.includes("..") || !port.paths.has(path)) {
      throw new ExportError("export_asset_denied");
    }
    let loaded = cache.get(path);
    if (!loaded) {
      loaded = pending
        .then(async () => {
          if (failure) {
            throw failure;
          }
          if (total >= limits.assets) {
            throw new ExportError("export_asset_total_limit");
          }
          const source = await port.read(path);
          bound(source.bytes, limits.asset);
          const bytes = source.bytes.slice();
          total += bytes.length;
          if (total > limits.assets) {
            throw new ExportError("export_asset_total_limit");
          }
          return verifiedImage(source.mime, bytes);
        })
        .catch((error) => {
          failure = error;
          throw error;
        });
      pending = loaded.then(
        () => undefined,
        () => undefined
      );
      cache.set(path, loaded);
    }
    return loaded.then((asset) => {
      references += asset.bytes.length;
      if (references > limits.assets) {
        failure = new ExportError("export_asset_reference_limit");
        throw failure;
      }
      return asset;
    });
  };
}
export type LoadAsset = ReturnType<typeof assetLoader>;
export function warn(
  warnings: Warning[],
  code: string,
  path: string,
  detail: string
) {
  warnings.push({ code, detail, path });
}

/** OOXML 1.0 cannot represent these code points; fail instead of producing a corrupt archive. */
function portableStrings(value: unknown, budget = { nodes: 0, text: 0 }): void {
  budget.nodes += 1;
  if (budget.nodes > limits.nodes) {
    throw new ExportError("export_node_limit");
  }
  if (typeof value === "string") {
    budget.text += value.length;
    if (budget.text > limits.text) {
      throw new ExportError("export_text_limit");
    }
    for (const scalar of value) {
      const code = scalar.codePointAt(0) ?? 0;
      if (
        (code < 32 && ![9, 10, 13].includes(code)) ||
        (code >= 0xd8_00 && code <= 0xdf_ff) ||
        code === 0xff_fe ||
        code === 0xff_ff
      ) {
        throw new ExportError("export_xml_character");
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      portableStrings(item, budget);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      portableStrings(item, budget);
    }
  }
}

/** Freeze the export's authorization inventory before its first asynchronous asset read. */
export function bindAssets(port: OwnAssets): OwnAssets {
  if (!(port && port.paths instanceof Set) || typeof port.read !== "function") {
    throw new ExportError("export_asset_port_required");
  }
  return { paths: new Set(port.paths), read: (path) => port.read(path) };
}
