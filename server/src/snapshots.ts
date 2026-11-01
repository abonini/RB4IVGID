import fs from "fs/promises";
import path from "path";
import type { PublicationStatus } from "../../shared/types";
import { logError, errorMessage } from "./log";
import type { ParsedCandidate } from "./sources/sovcWorkbook";

export interface StoredSnapshot {
  id: string;
  sourceType: "sovc" | "pdf" | "manual";
  sourceUrl: string;
  contentHash: string;
  retrievedAt: string;
  publishedAt: string | null;
  checkedAt: string;
  status: PublicationStatus;
  manual: boolean;
  candidates: ParsedCandidate[];
  contestTotal: number;
}

export async function writeCurrent(snapshotDir: string, snapshot: StoredSnapshot): Promise<void> {
  await writeJsonAtomic(path.join(snapshotDir, "current.json"), snapshot);
}

export async function writeHistory(snapshotDir: string, snapshot: StoredSnapshot): Promise<void> {
  const filePath = path.join(snapshotDir, "history", `${snapshot.id}.json`);
  await writeJsonAtomic(filePath, snapshot);
}

export async function readLatest(snapshotDir: string): Promise<StoredSnapshot | null> {
  const current = await readSnapshotFile(path.join(snapshotDir, "current.json"));
  if (current) return current;
  return readNewestHistory(snapshotDir);
}

export async function countHistory(snapshotDir: string): Promise<number> {
  try {
    const names = await fs.readdir(path.join(snapshotDir, "history"));
    return names.filter((name) => name.endsWith(".json")).length;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") logError("history_count_failed", { message: errorMessage(error) });
    return 0;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readNewestHistory(snapshotDir: string): Promise<StoredSnapshot | null> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(snapshotDir, "history"));
  } catch {
    return null;
  }
  const files = names.filter((name) => name.endsWith(".json")).sort();
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const snapshot = await readSnapshotFile(path.join(snapshotDir, "history", files[index]));
    if (snapshot) return snapshot;
  }
  return null;
}

async function readSnapshotFile(filePath: string): Promise<StoredSnapshot | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!isSnapshot(parsed)) {
      logError("snapshot_invalid", { file: path.basename(filePath) });
      return null;
    }
    return parsed;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    logError("snapshot_read_failed", { file: path.basename(filePath), message: errorMessage(error) });
    return null;
  }
}

function isSnapshot(value: unknown): value is StoredSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as StoredSnapshot;
  const sourceType = snapshot.sourceType;
  return (sourceType === "sovc" || sourceType === "pdf" || sourceType === "manual")
    && typeof snapshot.id === "string"
    && typeof snapshot.sourceUrl === "string"
    && typeof snapshot.contentHash === "string"
    && typeof snapshot.retrievedAt === "string"
    && typeof snapshot.checkedAt === "string"
    && (snapshot.status === "official" || snapshot.status === "unofficial")
    && typeof snapshot.manual === "boolean"
    && typeof snapshot.contestTotal === "number"
    && Array.isArray(snapshot.candidates)
    && snapshot.candidates.every(isCandidate);
}

function isCandidate(value: unknown): value is ParsedCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ParsedCandidate;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && Number.isInteger(candidate.votes)
    && candidate.votes >= 0;
}
