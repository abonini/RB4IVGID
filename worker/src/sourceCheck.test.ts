import assert from "node:assert/strict";
import test from "node:test";
import { memoryKv } from "./memoryKv";
import { checkSource } from "./sourceCheck";

const page = "https://www.washoecounty.gov/voters/results/2026data.php";
const workbook = "https://www.washoecounty.gov/voters/results/datafiles/general.xlsx";
const dispatchUrl = "https://api.github.com/repos/abonini/RB4IVGID/dispatches";
const html = `<h3>Primary Election</h3>
<a href="https://www.washoecounty.gov/voters/results/datafiles/primary.xlsx">Download Unofficial Statement of Votes Cast</a>
<h3>General Election</h3>
<a href="${workbook}">Download Unofficial Statement of Votes Cast</a>`;

test("dispatches once per revision and retries after three minutes", async () => {
  const kv = memoryKv();
  let etag = '"one"';
  let dispatches = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === page) return new Response(html);
    if (url === workbook) {
      return new Response(null, { status: 200, headers: { etag, "content-length": "100" } });
    }
    if (url === dispatchUrl) {
      dispatches += 1;
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
      const body = JSON.parse(String(init?.body)) as { event_type: string };
      assert.equal(body.event_type, "ivgid-results-updated");
      return new Response(null, { status: 204 });
    }
    return new Response("missing", { status: 404 });
  };
  const env = { IVGID_RESULTS: kv, GITHUB_DISPATCH_TOKEN: "test-token" };
  const start = Date.parse("2026-11-03T20:00:00.000Z");

  await checkSource(env, fetchImpl, start);
  assert.equal(dispatches, 1);
  const afterFirst = kv.writes();

  await checkSource(env, fetchImpl, start + 60_000);
  assert.equal(dispatches, 1);
  assert.equal(kv.writes(), afterFirst);

  etag = '"two"';
  await checkSource(env, fetchImpl, start + 120_000);
  assert.equal(dispatches, 2);

  await checkSource(env, fetchImpl, start + 120_000 + 2 * 60_000);
  assert.equal(dispatches, 2);

  await checkSource(env, fetchImpl, start + 120_000 + 3 * 60_000);
  assert.equal(dispatches, 3);
});

test("dispatches a live dashboard refresh every three minutes before SOVC appears", async () => {
  const kv = memoryKv();
  let dispatches = 0;
  const noSovc = `<h3>General Election</h3><p>Download Unofficial Statement of Votes Cast</p><h3>Primary Election</h3>`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === page) return new Response(noSovc);
    if (url === dispatchUrl) {
      dispatches += 1;
      const body = JSON.parse(String(init?.body)) as { client_payload: { observedUrl: string } };
      assert.equal(body.client_payload.observedUrl, "https://electionresults.washoecounty.gov/");
      return new Response(null, { status: 204 });
    }
    return new Response("missing", { status: 404 });
  };
  const env = { IVGID_RESULTS: kv, GITHUB_DISPATCH_TOKEN: "test-token" };
  const start = Date.parse("2026-11-03T20:00:00.000Z");
  await checkSource(env, fetchImpl, start);
  assert.equal(dispatches, 1);
  await checkSource(env, fetchImpl, start + 60_000);
  assert.equal(dispatches, 1);
  await checkSource(env, fetchImpl, start + 3 * 60_000);
  assert.equal(dispatches, 2);
});

test("does not dispatch again after the revision is imported", async () => {
  const kv = memoryKv();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === page) return new Response(html);
    if (url === workbook) return new Response(null, { status: 200, headers: { etag: '"one"' } });
    if (url === dispatchUrl) return new Response(null, { status: 204 });
    return new Response("missing", { status: 404 });
  };
  const env = { IVGID_RESULTS: kv, GITHUB_DISPATCH_TOKEN: "test-token" };
  const start = Date.parse("2026-11-03T20:00:00.000Z");
  await checkSource(env, fetchImpl, start);
  await kv.put("current", JSON.stringify({
    contentHash: "a".repeat(64),
    sourceUrl: workbook,
    etag: '"one"',
    lastModified: null,
    status: "unofficial",
    certified: false,
    publishedAt: null,
    importedAt: "2026-11-03T20:01:00.000Z",
    candidates: [],
    contestTotal: 0,
    sourceLabel: "Download Unofficial Statement of Votes Cast",
    contestTitle: "IVGID",
    historyKeys: [],
  }));
  const writes = kv.writes();
  await checkSource(env, fetchImpl, start + 10 * 60_000);
  const monitor = JSON.parse((await kv.get("monitor")) ?? "{}") as { settledRevisionKey: string | null; dispatchStatus: string };
  assert.equal(monitor.dispatchStatus, "idle");
  assert.ok(monitor.settledRevisionKey);
  assert.equal(kv.writes(), writes + 1);
});
