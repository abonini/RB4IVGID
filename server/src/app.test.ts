import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { createApp } from "./app";
import type { RuntimeConfig } from "./config";
import { createResultsService } from "./resultsService";

test("manual entry requires the configured token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ivgid-app-"));
  const config = {
    discoveryPageUrl: "https://www.washoecounty.gov/voters/results/2026data.php",
    officialResultsUrl: "https://electionresults.washoecounty.gov/",
    contestPattern: "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT",
    electionYear: 2026,
    electionDate: "2026-11-03",
    office: "Incline Village General Improvement District Trustee",
    term: "Four years",
    seats: 2,
    voteFor: 2,
    displayOrder: [],
    candidates: [
      { id: "brooks", displayName: "Ryan \"RB\" Brooks", match: ["brooks"] },
      { id: "noble", displayName: "David S. Noble", match: ["noble"] },
      { id: "swenson", displayName: "Harry Swenson", match: ["swenson"] },
    ],
    mode: "manual" as const,
    sourceUrl: "",
    pdfUrl: "",
    adminToken: "",
    snapshotDir: directory,
    port: 0,
    refreshIntervalMs: 300_000,
  } satisfies RuntimeConfig;
  const closed = createApp(createResultsService({ config }), config);
  const closedServer = closed.listen(0);
  const closedPort = listenPort(closedServer);
  const missing = await fetch(`http://127.0.0.1:${closedPort}/api/manual-entry`, { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);
  await closeServer(closedServer);

  const openConfig = { ...config, adminToken: "secret" };
  const open = createApp(createResultsService({ config: openConfig }), openConfig);
  const server = open.listen(0);
  const port = listenPort(server);
  const denied = await fetch(`http://127.0.0.1:${port}/api/manual-entry`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 401);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  const payload = await health.json() as { ok: boolean; mode: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "manual");
  await closeServer(server);
});

function closeServer(server: { close: (callback: (error?: Error) => void) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listenPort(server: { address: () => string | { port: number } | null }): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");
  return address.port;
}
