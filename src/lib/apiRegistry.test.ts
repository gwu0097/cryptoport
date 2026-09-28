import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { API_SERVICES, UNLISTED_HOSTS, hostMatches } from "./apiRegistry.ts";

// Every https host the app's code names must be on Owner's console → API
// list, or named as not a scaling concern (apiRegistry.ts). A new API fails
// here until someone decides which. Tests and the registry itself aren't
// scanned; hosts built at runtime (`https://${host}`) are covered by their
// "*.suffix" patterns in the registry by hand.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|mts|mjs)$/.test(name) && !/\.test\.ts$/.test(name) && !p.endsWith("apiRegistry.ts") ? [p] : [];
  });
}

test("every external host in the code is on the API list or named as not needing it", () => {
  const patterns = [...API_SERVICES.flatMap((s) => s.hosts), ...UNLISTED_HOSTS.flatMap((u) => u.hosts)];
  const missing = new Map<string, string>();
  const seen = new Set<string>();
  for (const f of [...files("src"), ...files("scripts")]) {
    for (const m of readFileSync(f, "utf8").matchAll(/https:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g)) {
      const host = m[1].toLowerCase();
      if (/(^|\.)example$|(^|\.)localhost$/.test(host)) continue;
      seen.add(host);
      if (!patterns.some((p) => hostMatches(host, p))) missing.set(host, f);
    }
  }
  assert.ok(seen.size > 100, `scanned only ${seen.size} hosts — the scan is broken`);
  assert.deepEqual([...missing].map(([h, f]) => `${h} (${f})`), [], "Add these to src/lib/apiRegistry.ts: API_SERVICES if they could need an upgrade, else UNLISTED_HOSTS");
});

test("each listed service says what it costs and how it scales", () => {
  for (const s of API_SERVICES) {
    assert.ok(s.plan && s.limits && s.scaling && s.hosts.length > 0, s.name);
  }
});
