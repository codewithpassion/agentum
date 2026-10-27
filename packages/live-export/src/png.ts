import { Unzlib } from "fflate";

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
    throw new Error("export_png_encoding");
  }
  const stride = width * channels + 1,
    expected = stride * height;
  let count = 0,
    at = 8,
    image = false,
    end = false;
  const decoder = new Unzlib((chunk) => {
    if (count + chunk.length > expected) {
      throw new Error("export_png_inflate_limit");
    }
    for (let i = 0; i < chunk.length; i += 1) {
      if ((count + i) % stride === 0 && (chunk[i] ?? 255) > 4) {
        throw new Error("export_png_filter");
      }
    }
    count += chunk.length;
  });
  while (at + 12 <= bytes.length) {
    const size = view.getUint32(at),
      type = view.getUint32(at + 4);
    if (
      size > bytes.length - at - 12 ||
      crc32(bytes, at + 4, at + 8 + size) !== view.getUint32(at + 8 + size)
    ) {
      throw new Error("export_png_chunk");
    }
    if (type === 0x49_48_44_52 && at !== 8) {
      throw new Error("export_png_chunk");
    }
    if (type === 0x49_44_41_54) {
      image = true;
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
      throw new Error("export_png_chunk_unsupported");
    }
    at += size + 12;
  }
  decoder.push(new Uint8Array(), true);
  if (!(image && end) || count !== expected) {
    throw new Error("export_png_incomplete");
  }
}
