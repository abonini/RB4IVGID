import assert from "node:assert/strict";
import test from "node:test";
import { discoverSovcUrl } from "./discoverSovc";

const pageUrl = "https://www.washoecounty.gov/voters/results/2026data.php";

test("uses the general election official workbook and ignores the primary section", () => {
  const html = `
    <nav><a href="results.php">2026 Primary Results Files</a></nav>
    <h3>General Election</h3>
    <td>Download Unofficial Statement of Votes Cast</td>
    <a href="datafiles/general-unofficial.xlsx">Download Unofficial Statement of Votes Cast</a>
    <a href="datafiles/general-official.xlsx">Download Official Statement of Votes Cast</a>
    <h3>Primary Election</h3>
    <a href="datafiles/WASHOE2026PRIMARYSOVCFINAL.xlsx">Download Official Statement of Votes Cast</a>
  `;
  const found = discoverSovcUrl(html, pageUrl);
  assert.equal(found?.url, "https://www.washoecounty.gov/voters/results/datafiles/general-official.xlsx");
});

test("uses the latest unofficial general file when no official link exists", () => {
  const html = `
    <h3>General Election</h3>
    <a href="datafiles/early.xlsx">Download Unofficial Statement of Votes Cast</a>
    <a href="datafiles/later.xlsx">Download Unofficial Statement of Votes Cast</a>
    <h3>Primary Election</h3>
  `;
  const found = discoverSovcUrl(html, pageUrl);
  assert.equal(found?.url, "https://www.washoecounty.gov/voters/results/datafiles/later.xlsx");
});

test("does not invent a url when the statement link has no href", () => {
  const html = `
    <h3>General Election</h3>
    <td>Download Unofficial Statement of Votes Cast</td>
    <h3>Primary Election</h3>
    <a href="datafiles/6-9-USOVC.xlsx">Download Unofficial Statement of Votes Cast</a>
  `;
  assert.equal(discoverSovcUrl(html, pageUrl), null);
});
