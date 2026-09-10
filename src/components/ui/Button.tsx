import type { ComponentProps } from "react";

type Variant = "primary" | "secondary" | "danger";
type Size = "sm" | "md";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110",
  secondary: "border border-border bg-surface-raised text-fg hover:bg-border",
  danger: "text-negative hover:bg-negative/10",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3 py-2 text-sm",
};

const BASE_CLASSES =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent";

// For non-<button> elements (e.g. a Link styled as a button) that need the
// same look without the disabled/pointer-events semantics of a real button.
export function buttonClass(variant: Variant = "primary", size: Size = "md"): string {
  return `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}`;
}

export type ButtonProps = { variant?: Variant; size?: Size } & ComponentProps<"button">;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    />
  );
}
