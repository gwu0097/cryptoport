"use client";

import { Button } from "./Button";

/** A row of mutually-exclusive pill buttons (e.g. chart range presets:
 * 7D/30D/90D/1Y/All) — extracted from Analytics' PerformanceChart once
 * Dashboard's ValueHistoryChart needed the identical control (see
 * ValueChart.tsx, which both now share). */
export function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((opt) => (
        <Button
          key={opt.key}
          type="button"
          variant={value === opt.key ? "primary" : "secondary"}
          size="sm"
          className={value === opt.key ? "" : "border-none bg-transparent"}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
