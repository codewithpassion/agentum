import { ServiceError } from "../errors.ts";

const invalid = (message: string) => new ServiceError("invalid", message);
export const imageMime = async (body: Blob) => {
  const head = new Uint8Array(await body.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder().decode(head);
  let mime: string | null = null;
  if (
    head[0] === 137 &&
    ascii.slice(1, 4) === "PNG" &&
    head[4] === 13 &&
    head[5] === 10 &&
    head[6] === 26 &&
    head[7] === 10
  ) {
    mime = "image/png";
  }
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) {
    mime = "image/jpeg";
  }
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    mime = "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    mime = "image/webp";
  }
  if (
    ascii.slice(4, 8) === "ftyp" &&
    ["avif", "avis"].includes(ascii.slice(8, 12))
  ) {
    mime = "image/avif";
  }
  if (!mime) {
    throw invalid("Upload a PNG, JPEG, GIF, WebP or AVIF image");
  }
  return mime;
};
