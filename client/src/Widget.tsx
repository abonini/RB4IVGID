import { useEffect, useRef, useState } from "react";
import { selectTopTwo } from "../../shared/ranking";
import type { ResultsResponse } from "../../shared/types";
import { formatPacific, formatShare, formatVotes } from "./format";

const POLL_MS = 30_000;

interface WidgetProps {
  layout: "standard" | "compact";
}

export function Widget({ layout }: WidgetProps) {
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasResults = useRef(false);

  useEffect(() => {
    let timer = 0;
    let cancelled = false;

    const load = async () => {
      if (hasResults.current) setRefreshing(true);
      try {
        const response = await fetch("/api/results");
        if (!response.ok) throw new Error(`Results request failed (${response.status})`);
        const payload = await response.json() as ResultsResponse;
        if (!payload || !Array.isArray(payload.candidates)) throw new Error("Results response was incomplete");
        if (cancelled) return;
        hasResults.current = true;
        setResults(payload);
        setLoadError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Results request failed";
        console.error("Results request failed", message);
        if (!cancelled) setLoadError(message);
      } finally {
        if (!cancelled) setRefreshing(false);
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
  }, [results, loadError, refreshing, layout]);

  const statusLabel = reportingStatus(results);

  return (
    <article className={layout === "compact" ? "widget widgetCompact" : "widget"}>
      <header className="widgetHeader">
        <p className="eyebrow">2026 General Election</p>
        <h1 className="electionTitle">IVGID Trustee Election</h1>
        <p className="electionDate">November 3, 2026</p>
        <p className="contestMeta">Four-Year Term · Vote for Two</p>
        {statusLabel ? <p className="reportingStatus">{statusLabel}</p> : null}
      </header>
      <StatusBanner results={results} loadError={loadError} refreshing={refreshing} />
      <CandidateList results={results} />
      <footer className="widgetFooter">
        <ResultTimes results={results} />
        <p className="sourceLine">{results?.source.detail ?? "Washoe County Registrar of Voters"}</p>
        <a className="sourceLink" href={results?.source.url ?? "https://electionresults.washoecounty.gov/"} target="_blank" rel="noopener noreferrer">
          Official county results
        </a>
      </footer>
    </article>
  );
}

function StatusBanner({
  results,
  loadError,
  refreshing,
}: {
  results: ResultsResponse | null;
  loadError: string | null;
  refreshing: boolean;
}) {
  if (results?.simulated) {
    return <p className="banner bannerSimulated">SIMULATED DATA — NOT OFFICIAL RESULTS</p>;
  }
  return (
    <div className="statusStack">
      {refreshing && results ? <p className="refreshing">Refreshing</p> : null}
      {results?.pendingSource ? <p className="banner bannerPending">New official results file found. Showing the last verified counts.</p> : null}
      {results?.ingestionFailure ? <p className="banner bannerWarning">The new county file could not be read. Showing the last verified counts.</p> : null}
      {results?.stale ? <p className="banner bannerWarning">{results.warning}</p> : null}
      {loadError && results ? <p className="banner bannerWarning">Showing the last results loaded in this page. The latest check failed.</p> : null}
      {!results?.stale && !results?.ingestionFailure && results?.warning ? <p className="banner bannerWarning">{results.warning}</p> : null}
      {loadError && !results ? <p className="banner bannerWarning">Results are temporarily unavailable.</p> : null}
      {results?.status === "awaiting" ? <p className="awaiting">Awaiting First Results.</p> : null}
      {!results && !loadError ? <p className="awaiting">Checking Washoe County results…</p> : null}
    </div>
  );
}

function CandidateList({ results }: { results: ResultsResponse | null }) {
  const candidates = results?.candidates ?? [];
  const ranking = selectTopTwo(candidates, results?.contest.seats ?? 2);
  const highlighted = new Set(ranking.ids);
  const label = ranking.tied ? "Tied — Currently Top Two" : "Currently Top Two";
  const unofficial = results?.status !== "official" && results?.status !== "awaiting";

  if (candidates.length === 0) return null;

  return (
    <>
      <ol className="candidateList">
        {candidates.map((candidate) => {
          const showRank = highlighted.has(candidate.id) && candidate.votes != null;
          const width = candidate.voteShare == null ? 0 : Math.min(100, Math.max(0, candidate.voteShare * 100));
          return (
            <li className={showRank ? "candidate candidateTopTwo" : "candidate"} key={candidate.id}>
              <div className="candidateHeader">
                <div className="candidateCopy">
                  <p className="candidateName">{candidate.name}</p>
                  {showRank ? <p className="topTwoLabel">{label}</p> : null}
                </div>
                <p className="candidateVotes">
                  {candidate.votes == null ? "—" : formatVotes(candidate.votes)}
                  {candidate.voteShare == null ? null : <span className="candidateShare">{formatShare(candidate.voteShare)}</span>}
                </p>
              </div>
              {candidate.votes == null ? null : (
                <div className="barTrack" role="img" aria-label={barLabel(candidate.name, candidate.votes, candidate.voteShare)}>
                  <div className="barFill" style={{ width: `${width}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {highlighted.size > 0 && unofficial && !results?.simulated ? <p className="topTwoNote">Results remain unofficial.</p> : null}
    </>
  );
}

function ResultTimes({ results }: { results: ResultsResponse | null }) {
  if (!results || results.simulated || results.status === "awaiting") return null;
  const imported = formatPacific(results.lastImportAt ?? results.retrievedAt);
  const checked = formatPacific(results.lastSourceCheckAt ?? null);
  return (
    <div className="timeBlock">
      {imported ? <p>Results imported {imported}</p> : null}
      {checked ? <p>County page checked {checked}</p> : null}
    </div>
  );
}

function reportingStatus(results: ResultsResponse | null): string | null {
  if (!results || results.simulated || results.status === "awaiting") return results?.simulated ? "Simulated preview" : null;
  if (results.certified) return "Certified results";
  if (results.status === "official") return "Official results";
  return "Unofficial results";
}

function barLabel(name: string, votes: number | null, voteShare: number | null): string {
  if (votes == null || voteShare == null) return `${name}, awaiting results`;
  return `${name}, ${formatVotes(votes)} votes, ${formatShare(voteShare)}`;
}
