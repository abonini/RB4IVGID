import config from "../election.config.json";
import { LIVE_RESULTS_URL, parseLiveDashboardText, type LiveDashboardResult } from "../server/src/sources/liveDashboard";

export async function fetchLiveDashboardResults(): Promise<LiveDashboardResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(LIVE_RESULTS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      (pattern) => document.body?.innerText?.includes(pattern),
      config.contestPattern,
      { timeout: 60_000 },
    );
    const text = await page.evaluate(() => document.body.innerText);
    if (!text || text.length < 40) throw new Error("Live results page body was empty");
    return parseLiveDashboardText(text, config);
  } finally {
    await browser.close();
  }
}
