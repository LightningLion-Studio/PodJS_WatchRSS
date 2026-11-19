import { readerRowKey, type ReaderRow, type ReaderRows } from "./content-layout.ts";

const MAX_CACHED_ENTRIES = 128;

/** Geometry probes and redraws share entries without retaining every row visited. */
export function readerWindowEntries<T>(rows: ReaderRows, make: (row: ReaderRow) => T, scope: unknown) {
  const cache = new Map<number, T>();
  const entries = {
    length: rows.length,
    at(index: number) {
      index = Math.trunc(index) || 0;
      if (index < 0) index += rows.length;
      if (index < 0 || index >= rows.length) return;

      const hit = cache.get(index);
      if (hit !== undefined) return hit;
      const value = make(rows.at(index)!);
      if (cache.size >= MAX_CACHED_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(index, value);
      return value;
    },
    *[Symbol.iterator](): Generator<T> {
      for (let index = 0; index < rows.length; index++) yield this.at(index)!;
    },
  };

  const indices = {
    get(key: unknown): number | undefined {
      if (typeof key !== "string") return;
      const match = /^(text|image|video):(\d+):(\d+)$/.exec(key);
      if (!match) return;
      const block = Number(match[2]), offset = Number(match[3]);

      // Source block and offset are ordered in both measured rows and placeholders.
      let low = 0, high = rows.length;
      while (low < high) {
        const mid = (low + high) >>> 1, row = rows.at(mid)!;
        if (row.blockIndex < block || (row.blockIndex === block && (row.sourceStart ?? 0) <= offset)) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }

      // A zero-length boundary can produce multiple equal keys. Keep the last index.
      for (let index = low - 1; index >= 0; index--) {
        const row = rows.at(index)!;
        if (row.blockIndex !== block || (row.sourceStart ?? 0) !== offset) break;
        if (readerRowKey(row) === key) return index;
      }
    },
  };
  return { entries, indices, scope };
}
