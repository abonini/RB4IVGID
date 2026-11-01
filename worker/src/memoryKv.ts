import type { ResultsKv } from "./records";

export function memoryKv(): ResultsKv & { writes: () => number } {
  const values = new Map<string, string>();
  let writes = 0;
  return {
    writes: () => writes,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
      writes += 1;
    },
    async delete(key) {
      values.delete(key);
    },
  };
}
