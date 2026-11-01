import { createRequire } from "module";
import { pathToFileURL } from "url";
import { namesMatch, normalizeName } from "../../../shared/names";
import { pacificTimestampToIso } from "../../../shared/time";
import type { ElectionConfig } from "../../../shared/types";
import { SourceError } from "../errors";
import { orderCandidates, type ParsedContest } from "./sovcWorkbook";
import { classifyPublication, parseVoteTotal } from "./votes";

const Y_TOLERANCE = 2.5;
const TOTAL_X_TOLERANCE = 28;
const MAX_PAGES = 80;
const PARTY_TOKENS = new Set(["np", "dem", "rep", "lpn", "iap", "ind"]);

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
}

interface TextToken {
  text: string;
  x: number;
  y: number;
}

interface ChoiceRow {
  name: string;
  votes: number;
}

export async function parsePdfSummary(data: Buffer, config: ElectionConfig): Promise<ParsedContest> {
  const items = await readPdfTextItems(data);
  return parseSummaryItems(items, config);
}

export function parseSummaryItems(items: PdfTextItem[], config: ElectionConfig): ParsedContest {
  const lines = groupTextItems(items);
  const documentText = lines.map(lineText).join("\n");
  if (!documentText.includes(String(config.electionYear))) {
    throw new SourceError(`PDF does not contain election year ${config.electionYear}`);
  }
  const rows = readContestRows(lines, config);
  const candidates = mapCandidates(rows.choices, config);
  const contestTotal = reportedTotal(rows.contestTotal, rows.choices);
  return {
    sourceType: "pdf",
    status: classifyPublication(documentText),
    publishedAt: findPublishedAt(documentText),
    candidates: orderCandidates(candidates, config.displayOrder),
    contestTotal,
  };
}

export function groupTextItems(items: PdfTextItem[]): TextToken[][] {
  const sorted = items
    .filter((item) => item.text.trim())
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const lines: TextToken[][] = [];
  for (const item of sorted) {
    const line = lines.find((existing) => Math.abs(existing[0].y - item.y) <= Y_TOLERANCE);
    const token = { text: item.text.trim(), x: item.x, y: item.y };
    if (line) line.push(token);
    else lines.push([token]);
  }
  return lines.map((line) => line.sort((left, right) => left.x - right.x));
}

function readContestRows(lines: TextToken[][], config: ElectionConfig): { choices: ChoiceRow[]; contestTotal: number | null } {
  const heading = lines.findIndex((line) => phraseIncluded(lineText(line), config.contestPattern));
  if (heading < 0) throw new SourceError("IVGID contest was not found in the PDF");
  const block = contestBlock(lines, heading, config.contestPattern);
  const header = block.find((line) => line.some((token) => normalizeName(token.text) === "total"));
  if (!header) throw new SourceError("PDF contest is missing a Total column");
  const totalToken = [...header].reverse().find((token) => normalizeName(token.text) === "total");
  if (!totalToken) throw new SourceError("PDF contest is missing a Total column");

  const choices: ChoiceRow[] = [];
  let contestTotal: number | null = null;
  for (const line of block.slice(block.indexOf(header) + 1)) {
    const name = lineName(line);
    if (!name) continue;
    const votes = totalNear(line, totalToken.x);
    if (votes == null) {
      if (config.candidates.some((candidate) => namesMatch(name, candidate.match))) {
        throw new SourceError(`PDF total for ${name} is not a valid integer`);
      }
      continue;
    }
    if (normalizeName(name) === "total" || normalizeName(name) === "total votes") {
      if (contestTotal != null && contestTotal !== votes) throw new SourceError("PDF contest totals disagree");
      contestTotal = votes;
      continue;
    }
    choices.push({ name, votes });
  }
  if (choices.length === 0) throw new SourceError("PDF contest did not include candidate totals");
  return { choices, contestTotal };
}

function contestBlock(lines: TextToken[][], heading: number, phrase: string): TextToken[][] {
  const voteForLines = lines
    .map((line, index) => ({ index, text: lineText(line) }))
    .filter((line) => /\(vote for/i.test(line.text));
  const ownVoteFor = voteForLines.find((line) => line.index >= heading);
  if (!ownVoteFor) throw new SourceError("PDF contest is missing the vote-for line");
  const nextContest = voteForLines.find((line) => line.index > ownVoteFor.index && !phraseIncluded(line.text, phrase));
  const end = nextContest?.index ?? lines.length;
  return lines.slice(heading, end);
}

function mapCandidates(choices: ChoiceRow[], config: ElectionConfig): ParsedContest["candidates"] {
  const byId = new Map<string, { id: string; name: string; votes: number; index: number }>();
  choices.forEach((choice, index) => {
    const matches = config.candidates.filter((candidate) => namesMatch(choice.name, candidate.match));
    if (matches.length > 1) throw new SourceError(`PDF row "${choice.name}" matches more than one candidate`);
    if (matches.length === 0) return;
    const candidate = matches[0];
    if (byId.has(candidate.id)) throw new SourceError(`${candidate.displayName} matches more than one PDF row`);
    byId.set(candidate.id, { id: candidate.id, name: candidate.displayName, votes: choice.votes, index });
  });
  const missing = config.candidates.find((candidate) => !byId.has(candidate.id));
  if (missing) throw new SourceError(`${missing.displayName} was not found in the PDF`);
  return [...byId.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ id, name, votes }) => ({ id, name, votes }));
}

function reportedTotal(reported: number | null, choices: ChoiceRow[]): number {
  const sum = choices.reduce((total, choice) => total + choice.votes, 0);
  if (reported == null) return sum;
  if (reported !== sum) throw new SourceError("PDF candidate totals do not match the contest total");
  return reported;
}

function totalNear(line: TextToken[], totalX: number): number | null {
  const integers = line.filter((token) => /^\d{1,3}(,\d{3})*$|^\d+$/.test(token.text.replace(/\s/g, "")));
  if (integers.length === 0) return null;
  const ranked = integers
    .map((token) => ({ token, distance: Math.abs(token.x - totalX) }))
    .sort((left, right) => left.distance - right.distance);
  if (ranked[0].distance > TOTAL_X_TOLERANCE) return null;
  if (ranked[1] && Math.abs(ranked[1].distance - ranked[0].distance) <= 1 && ranked[1].token.text !== ranked[0].token.text) {
    throw new SourceError("PDF total column is ambiguous");
  }
  return parseVoteTotal(ranked[0].token.text);
}

function lineName(line: TextToken[]): string {
  return line
    .filter((token) => !isNumericToken(token.text) && !PARTY_TOKENS.has(normalizeName(token.text)))
    .map((token) => token.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNumericToken(value: string): boolean {
  return /^-?[\d,]+(\.\d+)?%?$/.test(value.trim());
}

function lineText(line: TextToken[]): string {
  return line.map((token) => token.text).join(" ").replace(/\s+/g, " ").trim();
}

function phraseIncluded(text: string, phrase: string): boolean {
  return normalizeName(text).includes(normalizeName(phrase));
}

function findPublishedAt(documentText: string): string | null {
  const match = documentText.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M\b/i);
  return match ? pacificTimestampToIso(match[0]) : null;
}

export async function readPdfTextItems(data: Buffer): Promise<PdfTextItem[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(__filename);
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    isEvalSupported: false,
  });
  const document = await task.promise;
  try {
    if (document.numPages > MAX_PAGES) throw new SourceError("PDF has too many pages");
    return await collectItems(document);
  } finally {
    await document.destroy();
  }
}

async function collectItems(document: { numPages: number; getPage: (pageNumber: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> }): Promise<PdfTextItem[]> {
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!isTextItem(item)) continue;
      items.push({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5] - (pageNumber - 1) * 10_000,
      });
    }
  }
  return items;
}

function isTextItem(value: unknown): value is { str: string; transform: number[] } {
  if (!value || typeof value !== "object" || !("str" in value) || !("transform" in value)) return false;
  const item = value as { str: unknown; transform: unknown };
  return typeof item.str === "string" && item.str.trim().length > 0 && Array.isArray(item.transform);
}
