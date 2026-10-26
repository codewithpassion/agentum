import type { StatusBand as StatusBandData } from "@repo/db/shared";
import { bandClass } from "./desk-logic.ts";

/** The one sentence under a desk card, coloured by its tone. */
export function StatusBandLine({ band }: { band: StatusBandData }) {
  return (
    <p
      className={`border-t px-3 py-1.5 text-xs ${bandClass(band.tone)}`}
      data-tone={band.tone}
    >
      {band.text}
    </p>
  );
}
