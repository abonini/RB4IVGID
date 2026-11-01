import fs from "fs";
import path from "path";
import type { CandidateConfig, ElectionConfig } from "../../shared/types";
import { SourceError } from "./errors";
import { validateUrl } from "./http/fetchOfficial";

export type DataMode = "live" | "mock" | "manual";

export interface RuntimeConfig extends ElectionConfig {
  mode: DataMode;
  sourceUrl: string;
  pdfUrl: string;
  adminToken: string;
  snapshotDir: string;
  port: number;
  refreshIntervalMs: number;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimeConfig {
  const filePath = path.join(cwd, "election.config.json");
  const election = readElectionConfig(filePath);
  const mode = readMode(env.DATA_MODE);
  const sourceUrl = (env.RESULTS_SOURCE_URL ?? "").trim();
  const pdfUrl = (env.RESULTS_PDF_URL ?? "").trim();
  const discoveryPageUrl = (env.DISCOVERY_PAGE_URL ?? election.discoveryPageUrl).trim();

  validateConfiguredUrl("RESULTS_SOURCE_URL", sourceUrl);
  validateConfiguredUrl("RESULTS_PDF_URL", pdfUrl);
  validateConfiguredUrl("discovery page", discoveryPageUrl);

  return {
    ...election,
    discoveryPageUrl,
    mode,
    sourceUrl,
    pdfUrl,
    adminToken: env.ADMIN_TOKEN ?? "",
    snapshotDir: env.SNAPSHOT_DIR ? path.resolve(env.SNAPSHOT_DIR) : path.join(cwd, "data"),
    port: readPort(env.PORT),
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  };
}

function readElectionConfig(filePath: string): ElectionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable";
    throw new SourceError(`Could not read election config: ${detail}`);
  }
  if (!isElectionConfig(parsed)) {
    throw new SourceError("election.config.json is missing required contest settings");
  }
  return parsed;
}

function isElectionConfig(value: unknown): value is ElectionConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as ElectionConfig;
  return typeof config.discoveryPageUrl === "string"
    && typeof config.officialResultsUrl === "string"
    && typeof config.contestPattern === "string"
    && config.contestPattern.trim().length > 0
    && Number.isInteger(config.electionYear)
    && typeof config.electionDate === "string"
    && typeof config.office === "string"
    && typeof config.term === "string"
    && Number.isInteger(config.seats)
    && config.seats > 0
    && Number.isInteger(config.voteFor)
    && Array.isArray(config.displayOrder)
    && Array.isArray(config.candidates)
    && config.candidates.length > 0
    && config.candidates.every(isCandidate)
    && config.displayOrder.every((id) => config.candidates.some((candidate) => candidate.id === id));
}

function isCandidate(value: unknown): value is CandidateConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as CandidateConfig;
  return typeof candidate.id === "string"
    && typeof candidate.displayName === "string"
    && Array.isArray(candidate.match)
    && candidate.match.every((token) => typeof token === "string" && token.trim().length > 0);
}

function readMode(value: string | undefined): DataMode {
  if (!value || value === "live") return "live";
  if (value === "mock" || value === "manual") return value;
  throw new SourceError("DATA_MODE must be live, mock, or manual");
}

function readPort(value: string | undefined): number {
  if (!value) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SourceError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function validateConfiguredUrl(label: string, value: string): void {
  if (!value) return;
  try {
    validateUrl(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid URL";
    throw new SourceError(`${label} is not allowed: ${detail}`);
  }
}
