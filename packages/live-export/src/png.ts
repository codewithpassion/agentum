import { Unzlib, unzlibSync } from "fflate";
import { ExportError } from "./error";

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xff_ff_ff_ff;
  for (let i = start; i < end; i += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: PNG CRC-32.
    crc ^= bytes[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      // biome-ignore lint/suspicious/noBitwiseOperators: PNG CRC-32.
      crc = (crc >>> 1) ^ (crc & 1 ? 0xed_b8_83_20 : 0);
    }
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: PNG CRC-32.
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}
/** Closed inert PNG subset: 8-bit noninterlaced grayscale/RGB/gray-alpha/RGBA, no ancillary chunks. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Closed PNG binary validation keeps bounds and chunk admission together.
export function verifyPNG(bytes: Uint8Array, width: number, height: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [depth, kind] = bytes.subarray(24, 26);
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
    kind ?? -1
  ];
  if (
    depth !== 8 ||
    !channels ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  ) {
    throw new ExportError("export_png_encoding");
  }
  const stride = width * channels + 1,
    expected = stride * height;
  let count = 0,
    at = 8,
    image = false,
    end = false;
  let adlerA = 1,
    adlerB = 0,
    chunks = 0;
  const compressed: Uint8Array<ArrayBuffer>[] = [];
  let trailer = new Uint8Array();
  const decoder = new Unzlib((chunk) => {
    if (count + chunk.length > expected) {
      throw new ExportError("export_png_inflate_limit");
    }
    for (let i = 0; i < chunk.length; i += 1) {
      adlerA = (adlerA + (chunk[i] ?? 0)) % 65_521;
      adlerB = (adlerB + adlerA) % 65_521;
      if ((count + i) % stride === 0 && (chunk[i] ?? 255) > 4) {
        throw new ExportError("export_png_filter");
      }
    }
    count += chunk.length;
  });
  while (at + 12 <= bytes.length) {
    chunks += 1;
    if (chunks > 4096) {
      throw new ExportError("export_png_chunk_limit");
    }
    const size = view.getUint32(at),
      type = view.getUint32(at + 4);
    if (
      size > bytes.length - at - 12 ||
      crc32(bytes, at + 4, at + 8 + size) !== view.getUint32(at + 8 + size)
    ) {
      throw new ExportError("export_png_chunk");
    }
    if (type === 0x49_48_44_52 && at !== 8) {
      throw new ExportError("export_png_chunk");
    }
    if (type === 0x49_44_41_54) {
      image = true;
      compressed.push(bytes.slice(at + 8, at + 8 + size));
      const tail = bytes.subarray(
        at + 8 + Math.max(0, size - 4),
        at + 8 + size
      );
      trailer = new Uint8Array([...trailer, ...tail]).slice(-4);
      for (let i = at + 8; i < at + 8 + size; i += 256) {
        decoder.push(
          bytes.subarray(i, Math.min(i + 256, at + 8 + size)),
          false
        );
      }
    } else if (type === 0x49_45_4e_44) {
      end = size === 0 && at + 12 === bytes.length;
      break;
    } else if (type !== 0x49_48_44_52) {
      throw new ExportError("export_png_chunk_unsupported");
    }
    at += size + 12;
  }
  decoder.push(new Uint8Array(), true);
  if (
    trailer.length !== 4 ||
    new DataView(trailer.buffer).getUint32(0) !== adlerB * 65_536 + adlerA
  ) {
    throw new ExportError("export_png_checksum");
  }
  if (!(image && end) || count !== expected) {
    throw new ExportError("export_png_incomplete");
  }
  // fflate ignores unused compressed bytes. A valid stream must NEED its last
  // DEFLATE byte: remove it (plus the four-byte Adler trailer) and require an
  // incomplete-stream error. Full-byte padding after BFINAL is not valid zlib.
  const payload = new Uint8Array(
    compressed.reduce((n, part) => n + part.length, 0)
  );
  let offset = 0;
  for (const part of compressed) {
    payload.set(part, offset);
    offset += part.length;
  }
  let completeWithoutLastByte = false;
  try {
    unzlibSync(payload.subarray(0, -1), { out: new Uint8Array(expected) });
    completeWithoutLastByte = true;
  } catch {
    // Expected: without its final DEFLATE byte, a complete stream is truncated.
  }
  if (completeWithoutLastByte) {
    throw new ExportError("export_png_stream");
  }
}
