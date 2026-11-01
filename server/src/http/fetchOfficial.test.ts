import assert from "node:assert/strict";
import test from "node:test";
import { fetchOfficial } from "./fetchOfficial";

const countyFile = "https://www.washoecounty.gov/voters/results/datafiles/results.xlsx";

test("rejects a private address before fetching", async () => {
  let called = false;
  await assert.rejects(
    () => fetchOfficial(countyFile, {
      lookupHost: async () => ["10.1.1.1"],
      fetchImpl: async () => {
        called = true;
        return new Response("nope");
      },
    }),
    /Blocked address/,
  );
  assert.equal(called, false);
});

test("rejects a redirect to a non-county host", async () => {
  await assert.rejects(
    () => fetchOfficial(countyFile, {
      lookupHost: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/results.xlsx" },
      }),
    }),
    /not an official Washoe County domain/,
  );
});

test("follows an allowlisted redirect and enforces the size limit", async () => {
  const nextUrl = "https://www.washoecounty.gov/voters/results/datafiles/final.xlsx";
  const result = await fetchOfficial(countyFile, {
    lookupHost: async () => ["8.8.8.8"],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === countyFile) {
        return new Response(null, { status: 302, headers: { location: nextUrl } });
      }
      return new Response(Buffer.from("ok"), { headers: { "last-modified": "Tue, 03 Nov 2026 20:00:00 GMT" } });
    },
  });
  assert.equal(result.finalUrl, nextUrl);
  assert.equal(result.body.toString(), "ok");
  assert.equal(result.lastModified, "Tue, 03 Nov 2026 20:00:00 GMT");

  await assert.rejects(
    () => fetchOfficial(countyFile, {
      lookupHost: async () => ["8.8.8.8"],
      maxBytes: 4,
      fetchImpl: async () => new Response(Buffer.from("too-large")),
    }),
    /size limit/,
  );
});

test("rejects credentialed and non-https urls", async () => {
  await assert.rejects(() => fetchOfficial("http://www.washoecounty.gov/file.xlsx"), /HTTPS/);
  await assert.rejects(() => fetchOfficial("https://user:pass@www.washoecounty.gov/file.xlsx"), /credentials/);
});
