import "server-only";
import { ImageResponse } from "next/og";
import type { CloseCard } from "./watchAlerts";

// A closed position's PnL image for its Discord alert (owner 2026-09-30:
// like a trading bot's card — the result huge, green or red). Drawn by
// next/og in the function that sends the alert and uploaded with it, so no
// extra request and no public endpoint. Only next/og's bundled font (Geist):
// a character it lacks, or any emoji, makes it fetch one from the web, so
// every text is cut to Latin letters first (sanitize).

const W = 800;
const H = 460;
const GREEN = "#22c55e";
const RED = "#ef4444";
const GREY = "#94a3b8";

/** Printable Latin only (the bundled font's range): no emoji, no arrows,
 * a coin or trader name in another script loses those letters. */
export const sanitize = (s: string) => s.replace(/[−–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim();

export async function renderCloseCard(trader: string, card: CloseCard): Promise<ArrayBuffer> {
  const tone = card.win === null ? GREY : card.win ? GREEN : RED;
  const t = sanitize;
  const pair = card.payTicker ? `${t(card.ticker)} / ${t(card.payTicker)}` : t(card.ticker);
  const small = { fontSize: 22, color: "#94a3b8" } as const;
  const value = { fontSize: 26, color: "#e2e8f0" } as const;
  const res = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0f172a" }}>
        <div style={{ width: 12, height: "100%", background: tone }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "36px 44px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", ...small }}>
            <span>{t(trader) || "Trader"} · closed</span>
            <span>CryptoPort</span>
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#f8fafc", marginTop: 10 }}>{pair || "Position"}</div>
          <div style={{ display: "flex", fontSize: 120, lineHeight: 1, color: tone, marginTop: 18 }}>{card.pct ? t(card.pct) : "Closed"}</div>
          <div style={{ display: "flex", fontSize: 40, color: tone, marginTop: 8, marginBottom: 24 }}>{card.result ? t(card.result) : "result unknown"}</div>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 36 }}>
            {card.inText && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={small}>In</span>
                <span style={value}>{t(card.inText)}</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={small}>Out</span>
              <span style={value}>{t(card.outText)}</span>
            </div>
            {card.held && (
              <div style={{ display: "flex", flexDirection: "column", marginLeft: "auto", alignItems: "flex-end" }}>
                <span style={small}>Time</span>
                <span style={value}>{t(card.held)}</span>
              </div>
            )}
          </div>
          {(card.entryMc || card.exitMc) && (
            <div style={{ display: "flex", marginTop: 12, ...small }}>
              {[card.entryMc && `Entry MC ${card.entryMc}`, card.exitMc && `Exit MC ${card.exitMc}`].filter(Boolean).map((x) => t(x as string)).join("   ·   ")}
            </div>
          )}
        </div>
      </div>
    ),
    { width: W, height: H },
  );
  return res.arrayBuffer();
}
