import type { ReactNode } from "react";

// A reading page: keeps a narrower measure than the table pages (AppShell's
// data-page-width) — long lines of text are hard to read.
export default function ReadingWidth({ children }: { children: ReactNode }) {
  return <div data-page-width="reading">{children}</div>;
}
