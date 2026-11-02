# Cloudflare deployment

The widget and API run as one Cloudflare Worker on the Free plan. GitHub Actions in `abonini/RB4IVGID` downloads and parses Washoe County’s Statement of Votes Cast workbook. The Worker never parses Excel. After the steps below, a supported workbook is published without a manual import.

Hosting stays at $0 only while the GitHub repository is public and the Worker stays on the Workers Free plan.

## GitHub

Repository: [abonini/RB4IVGID](https://github.com/abonini/RB4IVGID.git)

1. Confirm the repository is public. Private repositories are not the $0 path for GitHub-hosted runners.
2. The workflow file must be on the default branch: `.github/workflows/sync-election-results.yml`. It runs on `repository_dispatch` (`ivgid-results-updated`), every five minutes, and `workflow_dispatch`.
3. Create a fine-grained personal access token for `abonini/RB4IVGID` only. Permission: Contents, Read and write. Leave Actions, secrets, and administration unset. This is the minimum GitHub accepts for `repository_dispatch`.
4. After the Worker is deployed, set the repository variable `RESULTS_API_BASE` to the Worker origin with no trailing slash, for example `https://ivgid-results.<account>.workers.dev`.
5. Set the Actions secret `ADMIN_TOKEN` to a long random value. Use the same value for the Worker secret below. Do not also create a variable named `ADMIN_TOKEN`.

Do not commit `.dev.vars`, `.wrangler/`, or any token. `.gitignore` already excludes them.

## Cloudflare

1. Create a free account at [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Install dependencies and log in:

```bash
npm install
npx wrangler login
```

3. Create the KV namespace and paste the printed id into `wrangler.jsonc` as the `IVGID_RESULTS` binding. Replace the placeholder id.

```bash
npx wrangler kv namespace create IVGID_RESULTS
```

4. The cron trigger is already `* * * * *` in `wrangler.jsonc`. `REFRESH_INTERVAL_SECONDS` is `60`. `GITHUB_REPOSITORY` is `abonini/RB4IVGID`.
5. Store the secrets. Neither is written to the repository.

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

`GITHUB_DISPATCH_TOKEN` is the fine-grained token from the GitHub section.

6. Build and deploy the Worker and the static widget:

```bash
npm test
npm run deploy
```

7. The widget URL is `https://<worker>.workers.dev/ivgid-results`.

Local preview of simulated totals, which does not write production KV:

```bash
npm run preview
```

## What the cron does

Every minute the Worker reads the general-election section of the Washoe reports page and looks for a Statement of Votes Cast link. It does not guess filenames. A new URL, ETag, or Last-Modified value is a new revision even when the filename stays the same. Content-Length is not treated as proof that the file is unchanged.

The Worker dispatches `https://api.github.com/repos/abonini/RB4IVGID/dispatches` once for that revision. It does not dispatch again every minute. A failed or unacknowledged dispatch retries after 3 minutes. GitHub Actions discovers the workbook itself, hashes the bytes, parses them with ExcelJS, and posts to `/api/admin/import`.

If Actions fails, the county site is down, or the workbook layout changes, the last verified totals stay in KV. The widget shows that the new file could not be read. The next successful publish clears the pending state and the error.

`lastSourceCheckAt`, `lastSourceChangeAt`, and `lastImportAt` are separate. A county-page check does not make the vote totals look new.

## API

- `GET /api/results` is public. The widget polls it every 30 seconds while the tab is visible.
- `GET /api/health` reports ingestion mode, the three timestamps, any pending revision, and `actionNeeded`. It does not include secrets.
- `POST /api/admin/import` is disabled unless `ADMIN_TOKEN` is set. Actions is the caller. The public widget does not receive the token.

## Wix iframe

Paste this into an HTML embed on brooksrb.com. No Velo and no Wix API keys.

```html
<iframe
  src="https://YOUR-WORKER.workers.dev/ivgid-results"
  title="2026 IVGID Trustee election results"
  width="100%"
  height="560"
  style="border:0;max-width:760px"
></iframe>
```

Use height `460` for a narrow phone layout if the card feels tall. The page does not scroll inside the frame at those heights. Any HTTPS page may frame the widget, including a Wix test site and the `filesusr.com` page Wix wraps around an HTML embed. In the Wix editor, set the embed box height to about 560. The editor canvas often stays gray until you open Preview or publish.

## Verification checklist

- `GET /api/health` shows `ingestionMode` of `actions` and does not contain the admin token or the GitHub token.
- `workflow_dispatch` on `sync-election-results` finishes without uploading a file by hand.
- A supported county workbook changes `lastImportAt` and the totals on `/ivgid-results`.
- Running the workflow again leaves `lastImportAt` unchanged.
- A workbook the parser rejects sets `ingestionFailure` and leaves the previous totals in place.
- The iframe loads on brooksrb.com at height 560 without an internal scrollbar.
- Cloudflare logs show one dispatch for a new revision, not one dispatch per minute.

## Logs

```bash
npx wrangler tail
```

KV writes should stay well under the Free plan’s 1,000 writes per day. Quiet minutes do not write. Usage and the cron history are under Workers & Pages in the Cloudflare dashboard.
