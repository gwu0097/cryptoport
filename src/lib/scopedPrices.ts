// A price map or stats map read from a scoped price read (docs/perf/
// PRICES_READ.md): it covers every coin in its scope, priced or not, so a
// lookup of a coin it doesn't cover is a scope mistake — reported through
// onMiss (the [render] line's scope-miss), never turned into a value. Pure.

/** Property reads that aren't coin lookups (await, JSON, React, inspection). */
const NOT_A_KEY = new Set(["then", "toJSON", "$$typeof", "@@iterator", "nodeType", "asymmetricMatch", "_isMockFunction"]);

export function guardRecord<T extends object>(record: T, onMiss: (key: string) => void, exempt: (key: string) => boolean = () => false): T {
  return new Proxy(record, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in target) && !NOT_A_KEY.has(key) && !exempt(key)) onMiss(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

export class GuardedMap<V> extends Map<string, V> {
  private readonly onMiss: (key: string) => void;
  private readonly exempt: (key: string) => boolean;
  constructor(onMiss: (key: string) => void, exempt: (key: string) => boolean = () => false) {
    super();
    this.onMiss = onMiss;
    this.exempt = exempt;
  }
  override get(key: string): V | undefined {
    if (!super.has(key) && !this.exempt(key)) this.onMiss(key);
    return super.get(key);
  }
}
