import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import test from "node:test";
import type { ElectionConfig } from "../../../shared/types";
import { parseSovcWorkbook } from "./sovcWorkbook";

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

test("reads a 2024-style sheet with rich text, spacers, and a masked precinct", async () => {
  const buffer = await workbookBuffer((sheet) => {
    sheet.getCell("A2").value = "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for  2)";
    sheet.getCell("A4").value = "Precinct";
    sheet.getCell("B4").value = "Registered  Voters";
    sheet.getCell("C4").value = "Precinct";
    sheet.getCell("E4").value = { richText: [{ text: "Swenson, Harry N.\n" }, { text: "(NP)" }] };
    sheet.getCell("G4").value = { richText: [{ text: "Brooks, Ryan \"RB\"\n" }, { text: "(NP)" }] };
    sheet.getCell("I4").value = "Noble, David S. (NP)";
    sheet.getCell("A8").value = "Election Day";
    sheet.getCell("E8").value = "****";
    sheet.getCell("G8").value = "****";
    sheet.getCell("I8").value = "****";
    writeTotals(sheet, 20, "Washoe County - Total", [100, 300, 200]);
    writeTotals(sheet, 21, "Cumulative - Total", [0, 0, 0]);
    writeTotals(sheet, 22, "County - Total", [100, 300, 200]);
  });

  const parsed = await parseSovcWorkbook(buffer, config, "Download Unofficial Statement of Votes Cast");
  assert.equal(parsed.status, "unofficial");
  assert.deepEqual(parsed.candidates.map((candidate) => [candidate.id, candidate.votes]), [
    ["swenson", 100],
    ["brooks", 300],
    ["noble", 200],
  ]);
  assert.equal(parsed.contestTotal, 600);
});

test("reads a 2026-style sheet and checks the contest total", async () => {
  const buffer = await workbookBuffer((sheet) => {
    sheet.getCell("A2").value = "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for  2)";
    sheet.getCell("A4").value = "Precinct";
    sheet.getCell("B4").value = "Times Cast";
    sheet.getCell("C4").value = "Registered  Voters";
    sheet.getCell("E4").value = "Undervotes";
    sheet.getCell("F4").value = "Overvotes";
    sheet.getCell("G4").value = "Precinct";
    sheet.getCell("H4").value = "BROOKS, RYAN";
    sheet.getCell("J4").value = "Noble, David S.";
    sheet.getCell("L4").value = "Swenson, Harry";
    sheet.getCell("N4").value = "Total Votes";
    sheet.getCell("A10").value = "INCLINE VILLAGE 8104";
    sheet.getCell("H10").value = 10;
    sheet.getCell("A12").value = "Washoe County - Total";
    sheet.getCell("H12").value = 300;
    sheet.getCell("I12").value = "50.0%";
    sheet.getCell("J12").value = 200;
    sheet.getCell("L12").value = 100;
    sheet.getCell("N12").value = 600;
    sheet.getCell("A13").value = "County - Total";
    sheet.getCell("H13").value = 300;
    sheet.getCell("J13").value = 200;
    sheet.getCell("L13").value = 100;
    sheet.getCell("N13").value = 600;
  }, "OFFICIAL FINAL RESULTS 2026");

  const parsed = await parseSovcWorkbook(buffer, { ...config, displayOrder: ["noble", "brooks", "swenson"] }, "Official Statement of Votes Cast");
  assert.equal(parsed.status, "official");
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.id), ["noble", "brooks", "swenson"]);
  assert.equal(parsed.contestTotal, 600);
});

test("rejects missing, ambiguous, masked, disagreeing, and non-integer totals", async () => {
  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => baseHeaders(sheet, ["Swenson, Harry", "Brooks, Ryan"])), config, ""),
    /David S. Noble was not found/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Brooks, Ryan", "Brooks, R. B.", "Noble, David", "Swenson, Harry"]);
      writeTotals(sheet, 12, "County - Total", [1, 2, 3, 4]);
    }), config, ""),
    /matches more than one column/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Brooks Noble, Pat"]);
      writeTotals(sheet, 12, "County - Total", [5]);
    }), config, ""),
    /matches more than one candidate/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Swenson, Harry", "Brooks, Ryan", "Noble, David"]);
      writeTotals(sheet, 12, "County - Total", ["****", 1, 2]);
    }), config, ""),
    /masked or missing/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Swenson, Harry", "Brooks, Ryan", "Noble, David"]);
      writeTotals(sheet, 12, "Washoe County - Total", [1, 2, 3]);
      writeTotals(sheet, 13, "County - Total", [9, 2, 3]);
    }), config, ""),
    /disagree/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Swenson, Harry", "Brooks, Ryan", "Noble, David"]);
      writeTotals(sheet, 12, "County - Total", [-1, 2, 3]);
    }), config, ""),
    /not a non-negative integer/,
  );

  await assert.rejects(
    async () => parseSovcWorkbook(await workbookBuffer((sheet) => {
      baseHeaders(sheet, ["Swenson, Harry", "Brooks, Ryan", "Noble, David"]);
      sheet.getCell("N4").value = "Total Votes";
      writeTotals(sheet, 12, "County - Total", [1, 2, 3], { totalColumn: "N", total: 10 });
    }), config, ""),
    /do not match the contest total/,
  );
});

test("rejects a workbook that is not the 2026 IVGID contest", async () => {
  const workbook = new ExcelJS.Workbook();
  const cover = workbook.addWorksheet("Cover");
  cover.getCell("A1").value = "General Election 2024";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => parseSovcWorkbook(buffer, config, ""), /election year 2026/);
});

function baseHeaders(sheet: ExcelJS.Worksheet, names: string[]): void {
  sheet.getCell("A2").value = "INCLINE VILLAGE GENERAL IMPROVEMENT DISTRICT (Vote for  2)";
  sheet.getCell("A4").value = "Precinct";
  names.forEach((name, index) => {
    sheet.getCell(4, 5 + index * 2).value = name;
  });
}

function writeTotals(
  sheet: ExcelJS.Worksheet,
  row: number,
  label: string,
  votes: Array<number | string>,
  total?: { totalColumn: string; total: number },
): void {
  sheet.getCell(`A${row}`).value = label;
  votes.forEach((votesForCandidate, index) => {
    sheet.getCell(row, 5 + index * 2).value = votesForCandidate;
  });
  if (total) sheet.getCell(`${total.totalColumn}${row}`).value = total.total;
}

async function workbookBuffer(
  fill: (sheet: ExcelJS.Worksheet) => void,
  coverText = "UNOFFICIAL RESULTS 2026",
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const cover = workbook.addWorksheet("Cover");
  cover.getCell("A1").value = coverText;
  const sheet = workbook.addWorksheet("Contest");
  fill(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
