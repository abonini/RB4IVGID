import { useEffect, useState, type CSSProperties } from "react";
import { selectTopTwo } from "../../shared/ranking";
import type { CandidateResult, ResultsResponse } from "../../shared/types";
import {
  type CountdownParts,
  countdownParts,
  hasLiveTotals,
  headerLabel,
  padUnit,
  showResultsOverlay,
} from "./electionNight";
import { formatPacific, formatShare, formatVotes } from "./format";

const POLL_MS = 30_000;
const OFFICIAL_RESULTS_URL = "https://electionresults.washoecounty.gov/";
const FALLBACK_CANDIDATES: CandidateResult[] = [
  { id: "brooks", name: "Ryan \"RB\" Brooks", votes: null, voteShare: null },
  { id: "noble", name: "David S. Noble", votes: null, voteShare: null },
  { id: "swenson", name: "Harry Swenson", votes: null, voteShare: null },
];

interface WidgetProps {
  layout: "standard" | "compact";
}

export function Widget({ layout }: WidgetProps) {
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const overlayVisible = showResultsOverlay(results) && (results !== null || Boolean(loadError));

  useEffect(() => {
    let timer = 0;
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/results");
        if (!response.ok) throw new Error(`Results request failed (${response.status})`);
        const payload = await response.json() as ResultsResponse;
        if (!payload || !Array.isArray(payload.candidates)) throw new Error("Results response was incomplete");
        if (cancelled) return;
        setResults(payload);
        setLoadError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Results request failed";
        console.error("Results request failed", message);
        if (!cancelled) setLoadError(message);
      }
    };

    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!document.hidden) void load();
        schedule();
      }, POLL_MS);
    };

    const onVisible = () => {
      if (!document.hidden) void load();
    };

    void load();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!overlayVisible) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [overlayVisible]);

  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return undefined;
    const sendHeight = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      window.parent.postMessage({ source: "ivgid-results", type: "resize", height }, "*");
    };
    sendHeight();
    const observer = new ResizeObserver(sendHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [results, loadError, overlayVisible, layout]);

  const widgetClass = layout === "compact" ? "widget widgetStacked" : "widget";

  return (
    <article className={widgetClass}>
      {results?.simulated ? <p className="simulatedBanner">SIMULATED DATA — NOT OFFICIAL RESULTS</p> : null}
      <header className="nightHeader">
        <div className="nightBanner">
          <h1 className="nightBannerText">Election Night Results</h1>
        </div>
        <p className="statusPill">{headerLabel(results, nowMs)}</p>
      </header>
      <WarningStrip results={results} loadError={loadError} />
      <div className="nightBody">
        <aside className="nightSidebar">
          <p className="sidebarEyebrow">2026 General Election</p>
          <div className="sidebarRule" />
          <h2 className="sidebarTitle">
            <span>IVGID</span>
            <span>Trustee</span>
            <span>Election</span>
          </h2>
        </aside>
        <section className={overlayVisible ? "resultsPanel resultsPanelOverlay" : "resultsPanel"} aria-label="Candidate results">
          <div className="resultsStage">
            <CandidateTable results={results} dimmed={overlayVisible} />
            {overlayVisible ? <CountdownOverlay parts={countdownParts(nowMs)} /> : null}
          </div>
          <footer className="nightFooter">
            <p className="footerTotal">{totalLabel(results)}</p>
            <div className="footerSource">
              <p>
                Source: Washoe County Registrar of Voters
                {" · "}
                <a className="sourceLink" href={results?.source.url ?? OFFICIAL_RESULTS_URL} target="_blank" rel="noopener noreferrer">
                  Official county results
                </a>
              </p>
              <ImportTime results={results} />
            </div>
          </footer>
        </section>
      </div>
    </article>
  );
}

function WarningStrip({ results, loadError }: { results: ResultsResponse | null; loadError: string | null }) {
  const messages = warningMessages(results, loadError);
  if (messages.length === 0) return null;
  return (
    <div className="warningStrip">
      {messages.map((message) => <p key={message}>{message}</p>)}
    </div>
  );
}

function warningMessages(results: ResultsResponse | null, loadError: string | null): string[] {
  const messages: string[] = [];
  if (results?.pendingSource) messages.push("New official results file found. Showing the last verified counts.");
  if (results?.ingestionFailure) messages.push("The new county file could not be read. Showing the last verified counts.");
  if (results?.stale && results.warning) messages.push(results.warning);
  if (!results?.stale && !results?.ingestionFailure && results?.warning) messages.push(results.warning);
  if (loadError && results) messages.push("Showing the last results loaded in this page. The latest check failed.");
  if (loadError && !results) messages.push("Results are temporarily unavailable.");
  return messages;
}

function CandidateTable({ results, dimmed }: { results: ResultsResponse | null; dimmed: boolean }) {
  const candidates = results && results.candidates.length > 0 ? results.candidates : FALLBACK_CANDIDATES;
  const highlighted = new Set(selectTopTwo(candidates, results?.contest.seats ?? 2).ids);
  const tableClass = dimmed ? "resultsTable resultsDimmed" : "resultsTable";

  return (
    <div className={tableClass}>
      <div className="resultsHead">
        <p>Candidate (ballot order)</p>
        <p className="columnNumber">Votes</p>
        <p className="columnNumber">Percent</p>
      </div>
      <ol className="candidateList">
        {candidates.map((candidate, index) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            ballotOrder={index + 1}
            highlighted={highlighted.has(candidate.id) && candidate.votes != null}
          />
        ))}
      </ol>
    </div>
  );
}

function CandidateRow({
  candidate,
  ballotOrder,
  highlighted,
}: {
  candidate: CandidateResult;
  ballotOrder: number;
  highlighted: boolean;
}) {
  const width = candidate.voteShare == null ? 0 : Math.min(100, Math.max(0, candidate.voteShare * 100));
  const rowClass = highlighted ? "candidateRow candidateTop" : "candidateRow";

  return (
    <li className={rowClass}>
      <div className="candidateIdentity">
        <p className="candidateName">
          <span className="ballotNumber">{ballotOrder}.</span>
          {" "}
          {candidate.name}
        </p>
        <div
          className="barTrack"
          role="img"
          aria-label={barLabel(candidate.name, candidate.votes, candidate.voteShare)}
          style={{ "--barWidth": `${width}%` } as CSSProperties}
        >
          <div className={highlighted ? "barFill barFillTop" : "barFill"} />
        </div>
      </div>
      <p className="voteCount">{candidate.votes == null ? "—" : formatVotes(candidate.votes)}</p>
      <p className="votePercent">{candidate.voteShare == null ? "—" : formatShare(candidate.voteShare)}</p>
    </li>
  );
}

function CountdownOverlay({ parts }: { parts: CountdownParts }) {
  if (parts.closed) {
    return (
      <div className="countdownOverlay">
        <div className="countdownCard">
          <p className="countdownTitle">POLLS CLOSED</p>
          <p className="countdownLead">Awaiting Official Election Results</p>
          <p className="countdownSupport">Results will appear here once released by Washoe County.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="countdownOverlay">
      <div className="countdownCard">
        <p className="countdownTitle">Countdown to Poll Closing</p>
        <p className="countdownSupport">Polls close November 3, 2026 · 7:00 PM PST</p>
        <div className="countdownTiles">
          <CountdownTile value={parts.days} label="Days" />
          <CountdownTile value={parts.hours} label="Hours" />
          <CountdownTile value={parts.minutes} label="Minutes" />
          <CountdownTile value={parts.seconds} label="Seconds" />
        </div>
      </div>
    </div>
  );
}

function CountdownTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="countdownTile">
      <p className="countdownValue">{padUnit(value)}</p>
      <p className="countdownLabel">{label}</p>
    </div>
  );
}

function ImportTime({ results }: { results: ResultsResponse | null }) {
  if (!hasLiveTotals(results)) return null;
  const imported = formatPacific(results?.lastImportAt ?? null);
  if (!imported) return null;
  return <p className="importTime">Results imported {imported}</p>;
}

function totalLabel(results: ResultsResponse | null): string {
  const candidates = results?.candidates ?? [];
  const showTotals = Boolean(results?.simulated) || hasLiveTotals(results);
  if (!showTotals || candidates.some((candidate) => candidate.votes == null)) {
    return "Results will populate when released.";
  }
  const total = candidates.reduce((sum, candidate) => sum + (candidate.votes ?? 0), 0);
  return `Total Votes: ${formatVotes(total)}`;
}

function barLabel(name: string, votes: number | null, voteShare: number | null): string {
  if (votes == null || voteShare == null) return `${name}, awaiting results`;
  return `${name}, ${formatVotes(votes)} votes, ${formatShare(voteShare)}`;
}
