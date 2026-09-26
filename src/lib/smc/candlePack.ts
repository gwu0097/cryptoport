// Completed candles packed as binary for the shared cache table
// (cryptoport.hl_candle_cache.candles): six float64 per candle — t, o, h, l,
// c, n — little-endian, 48 bytes each. A candle without a trade count stores
// NaN there and reads back without one. Pure.

import type { Candle } from "./engine.ts";

const FIELDS = 6;

export function packCandles(candles: readonly Candle[]): Uint8Array {
  const out = new Float64Array(candles.length * FIELDS);
  candles.forEach((c, i) => {
    out.set([c.t, c.o, c.h, c.l, c.c, c.n ?? NaN], i * FIELDS);
  });
  // Float64Array is platform-endian; DataView pins little-endian for storage.
  const bytes = new Uint8Array(out.length * 8);
  const view = new DataView(bytes.buffer);
  out.forEach((v, i) => view.setFloat64(i * 8, v, true));
  return bytes;
}

export function unpackCandles(bytes: Uint8Array): Candle[] {
  if (bytes.length % (FIELDS * 8) !== 0) throw new Error(`packed candles: ${bytes.length} bytes isn't a whole number of candles`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Candle[] = [];
  for (let off = 0; off < bytes.length; off += FIELDS * 8) {
    const f = (k: number) => view.getFloat64(off + k * 8, true);
    const n = f(5);
    out.push({ t: f(0), o: f(1), h: f(2), l: f(3), c: f(4), ...(Number.isNaN(n) ? {} : { n }) });
  }
  return out;
}

/** Postgres bytea over PostgREST: sent and returned as "\x" + hex. */
export const toByteaHex = (bytes: Uint8Array) => `\\x${Buffer.from(bytes).toString("hex")}`;
export function fromByteaHex(s: string): Uint8Array {
  if (!s.startsWith("\\x")) throw new Error("expected a bytea hex string");
  return new Uint8Array(Buffer.from(s.slice(2), "hex"));
}
