"use client";

import { useRouter } from "next/navigation";
import { inputClass } from "../ui/Field";
import type { IndicatorDef } from "@/lib/smc/indicators";

/** Which indicator the Signals page shows — keeps the other params. */
export function IndicatorSelect({ indicators, selected, baseQuery }: { indicators: IndicatorDef[]; selected: string; baseQuery: string }) {
  const router = useRouter();
  return (
    <label className="text-xs text-fg-muted">
      Indicator
      <select
        value={selected}
        onChange={(e) => router.push(`/signals?ind=${encodeURIComponent(e.target.value)}&${baseQuery}`)}
        className={`${inputClass} mt-1 block w-auto px-2 py-1.5 text-sm`}
      >
        {indicators.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label}
          </option>
        ))}
      </select>
    </label>
  );
}
