// The image card for a Perp Scout alert (owner 2026-10-08: "more polished… a
// table"): a dark card with the accent bar, the coin and side, the headline
// number, and a real table — a header row over its values, grid lines, the
// P/L coloured. Drawn locally by next's bundled @vercel/og (satori + resvg):
// ~3 ms a card after the first (~50 ms, loading the renderer), no network, no
// tokens. Only its bundled font (Geist): any character it lacks — an emoji, a
// non-Latin name — would make it fetch one from the web, so every text is cut
// to printable Latin first (the Wallet Watch cards do the same, closeCardImage.tsx).

import { createElement as h, type ReactElement } from "react";
import type { AlertCard, CardCell } from "../src/lib/perpScout/alerts.ts";

const C = { bg: "#0b1220", panel: "#111a2e", line: "#24314d", muted: "#8a97b0", text: "#e6ecf5", pos: "#22c55e", neg: "#ef4444" };
// Drawn for how Discord shows it: an embed's image is scaled to ~400 px wide,
// so the canvas is 800 (2x, crisp) with large text, and the table wraps to
// rows of 4 columns (owner 2026-10-08: the 1,100 px single row was unreadable).
const W = 800;
const PER_ROW = 4;

/** Printable Latin only (the bundled font's range). */
const clean = (s: string) => s.replace(/[−–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim();
const toneColor = (t: CardCell["tone"]) => (t === "pos" ? C.pos : t === "neg" ? C.neg : t === "muted" ? C.muted : C.text);

function view(card: AlertCard): ReactElement {
  const cell = (c: CardCell, i: number) =>
    h(
      "div",
      { key: i, style: { flex: 1, display: "flex", flexDirection: "column", padding: "14px 18px", borderLeft: i ? `2px solid ${C.line}` : "none" } },
      h("div", { style: { display: "flex", fontSize: 21, letterSpacing: 1, color: C.muted } }, clean(c.label).toUpperCase()),
      h("div", { style: { display: "flex", fontSize: 34, marginTop: 6, color: toneColor(c.tone) } }, clean(c.value)),
    );
  const rows: CardCell[][] = [];
  for (let i = 0; i < card.cells.length; i += PER_ROW) rows.push(card.cells.slice(i, i + PER_ROW));
  const head = card.headTone === "pos" ? C.pos : card.headTone === "neg" ? C.neg : C.text;
  return h(
    "div",
    { style: { width: "100%", height: "100%", display: "flex", background: C.bg } },
    h("div", { style: { width: 14, height: "100%", background: card.accent } }),
    h(
      "div",
      { style: { flex: 1, display: "flex", flexDirection: "column", padding: "26px 30px" } },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { display: "flex", fontSize: 22, letterSpacing: 2, color: card.accent } }, clean(card.kind)),
          h("div", { style: { display: "flex", fontSize: 46, color: C.text, marginTop: 2 } }, clean(card.title)),
        ),
        h("div", { style: { display: "flex", fontSize: 64, color: head } }, clean(card.headline)),
      ),
      h("div", { style: { display: "flex", fontSize: 23, color: C.muted, marginTop: 4 } }, clean(card.sub)),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", marginTop: 20, border: `2px solid ${C.line}`, borderRadius: 12, background: C.panel } },
        ...rows.map((row, r) =>
          h("div", { key: r, style: { display: "flex", borderTop: r ? `2px solid ${C.line}` : "none" } }, ...row.map((c, i) => cell(c, i)), ...Array.from({ length: PER_ROW - row.length }, (_, k) => h("div", { key: `pad${k}`, style: { flex: 1, display: "flex", borderLeft: `2px solid ${C.line}` } }))),
        ),
      ),
    ),
  );
}

/** Height for the rows the card has. */
const heightFor = (card: AlertCard) => 214 + Math.ceil(card.cells.length / PER_ROW) * 104;

// The renderer is loaded on first use (~50 ms), not at startup.
let renderer: Promise<{ ImageResponse: new (el: ReactElement, opts: { width: number; height: number }) => Response }> | null = null;

/** The card as a PNG. Throws on failure — the caller posts the text card. */
export async function renderAlertCard(card: AlertCard): Promise<ArrayBuffer> {
  renderer ??= import("next/dist/compiled/@vercel/og/index.node.js") as never;
  const { ImageResponse } = await renderer;
  return new ImageResponse(view(card), { width: W, height: heightFor(card) }).arrayBuffer();
}
