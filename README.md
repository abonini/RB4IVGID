# 2026 IVGID Trustee Results Widget

Embeddable election-night results for the Incline Village General Improvement District Trustee race. A Cloudflare Worker serves the widget and a public read-only API. GitHub Actions reads Washoe County’s Statement of Votes Cast workbook, keeps the last validated totals when an update fails, and never turns a parse error into zero votes.

The county does not publish a results API. General-election workbook links appear on the [2026 Election Reports](https://www.washoecounty.gov/voters/results/2026data.php) page when the Registrar posts them. Until that link exists, the widget shows **Awaiting First Results.**

Deployment, secrets, and the Wix snippet are in [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md).

## Local development

```bash
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:5173/ivgid-results`. The Vite server proxies `/api` to the Worker.

Simulated totals, for layout checks only:

```bash
npm run preview
```

The widget shows `SIMULATED DATA — NOT OFFICIAL RESULTS`. Preview mode never writes the production KV namespace.

Contest names and candidate match tokens live in [election.config.json](election.config.json). `displayOrder` lists candidate ids when the card should not follow the county’s column order. Leave it empty to keep source ballot order.

`GET /api/health` reports the county check time, the detected source change, and the last successful import separately. `GET /api/results` is public and does not require a token.

## Wix iframe

Desktop height 560. Use 460 on a narrow phone if the card feels tall. The full snippet is in [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md).

```html
<iframe
  src="https://YOUR-WORKER.workers.dev/ivgid-results"
  title="2026 IVGID Trustee election results"
  width="100%"
  height="560"
  style="border:0;max-width:760px"
></iframe>
```

The widget does not scroll internally. Optional auto-resize, if the Wix page can run this script:

```html
<script>
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.source !== "ivgid-results" || event.data.type !== "resize") return;
    const frame = document.getElementById("ivgid-results-frame");
    if (frame) frame.style.height = event.data.height + "px";
  });
</script>
<iframe
  id="ivgid-results-frame"
  src="https://YOUR-WORKER.workers.dev/ivgid-results"
  title="2026 IVGID Trustee election results"
  style="width: 100%; height: 560px; border: 0; overflow: hidden;"
  scrolling="no"
></iframe>
```

Give the iframe `id="ivgid-results-frame"` when using the script. The message contains only the widget height.

## What the card shows

- All three candidates in county column order, unless `displayOrder` is set.
- Vote counts, one-decimal vote share, and bars using that same share.
- “Currently Top Two” from the published totals. A tie for second includes every tied candidate and reads “Tied — Currently Top Two.” The names stay in ballot order. Zeros and awaiting results are not ranked.
- “Results imported” for the last validated publish, and “County page checked” only as the source check. A source check does not refresh the totals.
- Unofficial, official, or certified only from the imported county file. The simulated banner replaces that label.
- The last validated totals, with a warning, when a newer file cannot be fetched or parsed.
