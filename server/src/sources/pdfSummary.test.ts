import assert from "node:assert/strict";
import test from "node:test";
import type { ElectionConfig } from "../../../shared/types";
import { parseSummaryItems, readPdfTextItems, type PdfTextItem } from "./pdfSummary";

const config: ElectionConfig = {
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
};

function item(text: string, x: number, y: number): PdfTextItem {
  return { text, x, y };
}

const report: PdfTextItem[] = [
  item("2026", 72, 760),
  item("OFFICIAL FINAL RESULTS", 140, 760),
  item("11/3/2026 8:00:00 PM", 72, 740),
  item("INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT", 72, 700),
  item("(Vote for 2)", 72, 680),
  item("Candidate", 72, 650),
  item("Total", 400, 650),
  item("Swenson, Harry", 72, 620),
  item("(NP)", 190, 620),
  item("100", 400, 620),
  item("Brooks, Ryan \"RB\"", 72, 600),
  item("300", 400, 600),
  item("Noble, David S.", 72, 580),
  item("200", 400, 580),
  item("OTHER OFFICE", 72, 520),
  item("(Vote for 1)", 72, 500),
  item("Brooks, Ryan", 72, 480),
  item("9999", 400, 480),
];

test("reads positioned summary text without taking the next contest", () => {
  const parsed = parseSummaryItems(report, config);
  assert.equal(parsed.status, "official");
  assert.equal(parsed.publishedAt, "2026-11-04T04:00:00.000Z");
  assert.deepEqual(parsed.candidates.map((candidate) => [candidate.id, candidate.votes]), [
    ["swenson", 100],
    ["brooks", 300],
    ["noble", 200],
  ]);
  assert.equal(parsed.contestTotal, 600);
});

test("rejects an ambiguous or incomplete pdf contest", () => {
  const duplicate = report.concat([item("Brooks, Ryan", 72, 560), item("50", 400, 560)]);
  assert.throws(() => parseSummaryItems(duplicate, config), /more than one PDF row/);
  const missing = report.filter((entry) => !entry.text.includes("Noble"));
  assert.throws(() => parseSummaryItems(missing, config), /David S. Noble was not found/);
});

test("reads text from a small generated pdf", async () => {
  const parsed = await readPdfTextItems(buildPdf([
    { text: "2026 OFFICIAL FINAL RESULTS", x: 72, y: 740 },
    { text: "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for 2)", x: 72, y: 700 },
    { text: "Candidate", x: 72, y: 660 },
    { text: "Total", x: 420, y: 660 },
    { text: "Brooks, Ryan RB", x: 72, y: 630 },
    { text: "10", x: 420, y: 630 },
    { text: "Noble, David S.", x: 72, y: 600 },
    { text: "20", x: 420, y: 600 },
    { text: "Swenson, Harry", x: 72, y: 570 },
    { text: "30", x: 420, y: 570 },
  ]));
  const result = parseSummaryItems(parsed, config);
  assert.equal(result.contestTotal, 60);
  assert.deepEqual(result.candidates.map((candidate) => candidate.votes), [10, 20, 30]);
});

function buildPdf(lines: Array<{ text: string; x: number; y: number }>): Buffer {
  const commands = ["BT", "/F1 12 Tf", ...lines.map((line) => {
    const escaped = line.text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    return `1 0 0 1 ${line.x} ${line.y} Tm (${escaped}) Tj`;
  }), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
