import {
  CURRENT_KEY,
  INGESTION_KEY,
  MONITOR_KEY,
  type CurrentSnapshot,
  type IngestionRecord,
  type MonitorRecord,
  type ResultsKv,
  emptyMonitor,
} from "./records";

export async function readJson<T>(kv: ResultsKv, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid json";
    console.error("Stored election record could not be parsed", key, detail);
    return null;
  }
}

export function readCurrent(kv: ResultsKv): Promise<CurrentSnapshot | null> {
  return readJson<CurrentSnapshot>(kv, CURRENT_KEY);
}

export async function readMonitor(kv: ResultsKv): Promise<MonitorRecord> {
  return (await readJson<MonitorRecord>(kv, MONITOR_KEY)) ?? emptyMonitor();
}

export function readIngestion(kv: ResultsKv): Promise<IngestionRecord | null> {
  return readJson<IngestionRecord>(kv, INGESTION_KEY);
}

export async function writeJson(kv: ResultsKv, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}
