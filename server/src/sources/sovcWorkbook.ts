import ExcelJS from "exceljs";
import { namesMatch, normalizeName } from "../../../shared/names";
import type { ElectionConfig } from "../../../shared/types";
import { SourceError } from "../errors";
import { classifyPublication, parseVoteTotal } from "./votes";

const MAX_SHEETS = 60;
const MAX_COLUMNS = 80;
const EXCERPT_ROWS = 25;
const MAX_CONTEST_ROWS = 5000;
const META_HEADERS = new Set([
  "precinct",
  "times cast",
  "registered voters",
  "voters",
  "undervotes",
  "overvotes",
  "total votes",
  "turnout",
  "percent turnout",
  "write in",
  "unresolved write in",
]);

export interface ParsedCandidate {
  id: string;
  name: string;
  votes: number;
}

export interface ParsedContest {
  sourceType: "sovc" | "pdf" | "manual";
  status: "official" | "unofficial";
  publishedAt: string | null;
  candidates: ParsedCandidate[];
  contestTotal: number;
  certified?: boolean;
}

interface ChoiceColumn {
  index: number;
  header: string;
}

interface Assignment {
  id: string;
  name: string;
  column: number;
}

export async function parseSovcWorkbook(
  data: Buffer,
  config: ElectionConfig,
  sourceLabel: string,
): Promise<ParsedContest> {
  const workbook = await loadWorkbook(data);
  const excerpts = workbook.worksheets.map((sheet) => sheetText(readGrid(sheet, EXCERPT_ROWS)));
  const joined = excerpts.join("\n");
  if (!joined.includes(String(config.electionYear))) {
    throw new SourceError(`Workbook does not contain election year ${config.electionYear}`);
  }

  const matches = excerpts
    .map((excerpt, index) => ({ excerpt, index }))
    .filter((sheet) => phraseIncluded(sheet.excerpt, config.contestPattern));
  if (matches.length !== 1) {
    throw new SourceError(matches.length === 0 ? "IVGID contest was not found" : "More than one IVGID contest sheet was found");
  }

  const contestSheet = workbook.worksheets[matches[0].index];
  const grid = readGrid(contestSheet, MAX_CONTEST_ROWS);
  const parsed = readContest(grid, config);
  const sourceText = `${sourceLabel}\n${joined}`;
  return {
    sourceType: "sovc",
    status: classifyPublication(sourceText),
    publishedAt: null,
    certified: /certified|official final/i.test(sourceText),
    candidates: orderCandidates(parsed.candidates, config.displayOrder),
    contestTotal: parsed.contestTotal,
  };
}

async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable workbook";
    throw new SourceError(`Workbook could not be read: ${detail}`);
  }
  if (workbook.worksheets.length > MAX_SHEETS) {
    throw new SourceError("Workbook has too many sheets");
  }
  return workbook;
}

function readContest(grid: string[][], config: ElectionConfig): { candidates: ParsedCandidate[]; contestTotal: number } {
  const headerIndex = grid.findIndex((row) => row.some((cell) => normalizeName(cell) === "precinct"));
  if (headerIndex < 0) throw new SourceError("Contest header row was not found");
  const header = grid[headerIndex];
  const columns = choiceColumns(header);
  const assignments = assignCandidates(columns, config);
  const totalRows = grid.slice(headerIndex + 1).filter(isCountyTotalRow);
  if (totalRows.length === 0) throw new SourceError("County total row was not found");

  const voteRows = totalRows.map((row) => votesByColumn(row, columns));
  for (const row of voteRows.slice(1)) {
    if (!sameVotes(voteRows[0], row, columns)) {
      throw new SourceError("County total rows disagree");
    }
  }

  const contestTotal = contestTotalFor(header, totalRows[0], columns, voteRows[0]);
  const candidates = assignments.map((assignment) => ({
    id: assignment.id,
    name: assignment.name,
    votes: voteRows[0].get(assignment.column) ?? failMissing(assignment.name),
  }));
  return { candidates, contestTotal };
}

function choiceColumns(header: string[]): ChoiceColumn[] {
  const columns: ChoiceColumn[] = [];
  const seen = new Set<string>();
  header.forEach((headerText, index) => {
    const normalized = normalizeName(headerText);
    if (!normalized || META_HEADERS.has(normalized)) return;
    if (seen.has(normalized)) throw new SourceError(`Duplicate column header: ${headerText}`);
    seen.add(normalized);
    columns.push({ index, header: headerText });
  });
  return columns;
}

function assignCandidates(columns: ChoiceColumn[], config: ElectionConfig): Assignment[] {
  const byId = new Map<string, Assignment>();
  for (const column of columns) {
    const matches = config.candidates.filter((candidate) => namesMatch(column.header, candidate.match));
    if (matches.length > 1) throw new SourceError(`Column "${column.header}" matches more than one candidate`);
    if (matches.length === 0) continue;
    const candidate = matches[0];
    if (byId.has(candidate.id)) throw new SourceError(`${candidate.displayName} matches more than one column`);
    byId.set(candidate.id, { id: candidate.id, name: candidate.displayName, column: column.index });
  }
  const missing = config.candidates.find((candidate) => !byId.has(candidate.id));
  if (missing) throw new SourceError(`${missing.displayName} was not found in the contest`);
  return [...byId.values()].sort((left, right) => left.column - right.column);
}

function votesByColumn(row: string[], columns: ChoiceColumn[]): Map<number, number> {
  return new Map(columns.map((column) => [column.index, parseVoteTotal(row[column.index] ?? "")]));
}

function sameVotes(left: Map<number, number>, right: Map<number, number>, columns: ChoiceColumn[]): boolean {
  return columns.every((column) => left.get(column.index) === right.get(column.index));
}

function contestTotalFor(header: string[], row: string[], columns: ChoiceColumn[], votes: Map<number, number>): number {
  const sum = columns.reduce((total, column) => total + (votes.get(column.index) ?? 0), 0);
  const totalIndex = header.findIndex((cell) => normalizeName(cell) === "total votes");
  if (totalIndex < 0) return sum;
  const reported = parseVoteTotal(row[totalIndex] ?? "");
  if (reported !== sum) throw new SourceError("Candidate totals do not match the contest total");
  return reported;
}

function isCountyTotalRow(row: string[]): boolean {
  return row.some((cell) => /county\s*-\s*total/i.test(cell));
}

function readGrid(sheet: ExcelJS.Worksheet, maxRows: number): string[][] {
  const columnCount = Math.min(MAX_COLUMNS, Math.max(sheet.columnCount, 1));
  const rowCount = Math.min(maxRows, Math.max(sheet.rowCount, 1));
  const grid: string[][] = [];
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(cleanCell(cellText(row.getCell(column).value)));
    }
    grid.push(cells);
  }
  return grid;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text ?? "").join("");
  }
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  if (typeof value === "object" && "result" in value) return cellText(value.result as ExcelJS.CellValue);
  return "";
}

function cleanCell(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sheetText(grid: string[][]): string {
  return grid.flat().filter(Boolean).join(" ");
}

function phraseIncluded(text: string, phrase: string): boolean {
  return normalizeName(text).includes(normalizeName(phrase));
}

function failMissing(name: string): never {
  throw new SourceError(`${name} is missing a county total`);
}

export function orderCandidates<T extends { id: string }>(candidates: T[], displayOrder: string[]): T[] {
  if (displayOrder.length === 0) return candidates;
  const rank = new Map(displayOrder.map((id, index) => [id, index]));
  return [...candidates].sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}
