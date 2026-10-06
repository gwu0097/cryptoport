// A sliding one-minute weight budget, for Hyperliquid's info API: every
// request has a weight (2 for clearinghouseState and allMids, 20 for most,
// plus 1 per 20 items a fills answer returns) and an IP may spend 1,200 a
// minute. `reserve` waits until a request fits; `charge` books weight learnt
// after the answer (the fills' extra). Clock and sleep are injected for tests.

export interface Pacer {
  reserve(weight: number): Promise<void>;
  charge(weight: number): void;
}

const WINDOW_MS = 60_000;

export function createPacer(budgetPerMinute: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Pacer {
  const spent: { at: number; weight: number }[] = [];
  const used = () => {
    const cutoff = now() - WINDOW_MS;
    while (spent.length && spent[0].at <= cutoff) spent.shift();
    return spent.reduce((s, x) => s + x.weight, 0);
  };
  // Reservations run one at a time so two waiters can't both see room.
  let queue: Promise<void> = Promise.resolve();
  return {
    reserve(weight) {
      const turn = queue.then(async () => {
        const w = Math.min(weight, budgetPerMinute);
        while (used() + w > budgetPerMinute) await sleep(Math.max(50, spent[0].at + WINDOW_MS - now()));
        spent.push({ at: now(), weight: w });
      });
      queue = turn.catch(() => {});
      return turn;
    },
    charge(weight) {
      if (weight > 0) spent.push({ at: now(), weight });
    },
  };
}
