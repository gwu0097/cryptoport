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
const W = 1100;
const H = 290;

/** Printable Latin only (the bundled font's range). */
const clean = (s: string) => s.replace(/[−–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim();
const toneColor = (t: CardCell["tone"]) => (t === "pos" ? C.pos : t === "neg" ? C.neg : t === "muted" ? C.muted : C.text);

function view(card: AlertCard): ReactElement {
  const cell = (c: CardCell, i: number, header: boolean) =>
    h(
      "div",
      {
        key: i,
        style: {
          flex: 1,
          display: "flex",
          padding: header ? "9px 14px" : "13px 14px",
          borderLeft: i ? `1px solid ${C.line}` : "none",
          fontSize: header ? 14 : 21,
          letterSpacing: header ? 1 : 0,
          color: header ? C.muted : toneColor(c.tone),
        },
      },
      header ? clean(c.label).toUpperCase() : clean(c.value),
    );
  const head = card.headTone === "pos" ? C.pos : card.headTone === "neg" ? C.neg : C.text;
  return h(
    "div",
    { style: { width: "100%", height: "100%", display: "flex", background: C.bg } },
    h("div", { style: { width: 10, height: "100%", background: card.accent } }),
    h(
      "div",
      { style: { flex: 1, display: "flex", flexDirection: "column", padding: "24px 32px" } },
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" } },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h("div", { style: { display: "flex", fontSize: 14, letterSpacing: 2, color: card.accent } }, clean(card.kind)),
          h("div", { style: { display: "flex", fontSize: 34, color: C.text, marginTop: 4 } }, clean(card.title)),
          h("div", { style: { display: "flex", fontSize: 16, color: C.muted, marginTop: 6 } }, clean(card.sub)),
        ),
        h("div", { style: { display: "flex", fontSize: 50, color: head } }, clean(card.headline)),
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", marginTop: 20, border: `1px solid ${C.line}`, borderRadius: 10, background: C.panel } },
        h("div", { style: { display: "flex", borderBottom: `1px solid ${C.line}` } }, ...card.cells.map((c, i) => cell(c, i, true))),
        h("div", { style: { display: "flex" } }, ...card.cells.map((c, i) => cell(c, i, false))),
      ),
      h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 13, color: C.muted } }, h("span", {}, "Hyperliquid perps"), h("span", {}, "CryptoPort · Perp Scout")),
    ),
  );
}

// The renderer is loaded on first use (~50 ms), not at startup.
let renderer: Promise<{ ImageResponse: new (el: ReactElement, opts: { width: number; height: number }) => Response }> | null = null;

/** The card as a PNG. Throws on failure — the caller posts the text card. */
export async function renderAlertCard(card: AlertCard): Promise<ArrayBuffer> {
  renderer ??= import("next/dist/compiled/@vercel/og/index.node.js") as never;
  const { ImageResponse } = await renderer;
  return new ImageResponse(view(card), { width: W, height: H }).arrayBuffer();
}
